import { Index, type Table } from "@lancedb/lancedb";
import type { FileManifestRepositoryPort } from "../../domain/ports/FileManifestRepositoryPort.js";
import type {
	DedupeReport,
	IndexMaintenancePort,
	OptimizeOptions,
	OptimizeReport,
	TableOptimizeReport,
	VectorIndexState,
} from "../../domain/ports/IndexMaintenancePort.js";
import { ChunkRepository } from "./ChunkRepository.js";
import { type LanceTables, TableName } from "./LanceTables.js";
import { VectorIndexPolicy } from "./VectorIndexPolicy.js";

/**
 * Keeps the LanceDB tables compact and their ANN indexes current.
 *
 * Without a vector index LanceDB answers a search by brute force: it decodes
 * every stored embedding to score it. At high dimensions that walks the whole
 * table through memory per query, so peak RSS tracks index size roughly 1:1.
 * IVF-PQ turns that into a handful of probes.
 *
 * Compaction matters for the same reason — small appends leave hundreds of
 * fragments, each carrying its own decode buffers.
 */
export class IndexMaintenance implements IndexMaintenancePort {
	/** Tables holding embeddings, and therefore wanting a vector index. */
	private static readonly VECTOR_TABLES = [TableName.Chunks] as const;

	constructor(
		private readonly tables: LanceTables,
		private readonly manifest: FileManifestRepositoryPort,
	) {}

	/**
	 * Cheap and idempotent when there is nothing to do, so it is safe to call
	 * after every build.
	 */
	async optimize(options: OptimizeOptions = {}): Promise<OptimizeReport> {
		const report: OptimizeReport = { tables: [] };
		for (const name of IndexMaintenance.VECTOR_TABLES) {
			const table = await this.tables.table(name);
			if (!table) continue;
			report.tables.push(
				await this.optimizeTable(
					name,
					table,
					options.force ?? false,
					options.create ?? false,
				),
			);
		}
		return report;
	}

	/**
	 * What `lmgrep compact` runs: the same work as {@link optimize} but
	 * unconditional, plus compaction of the files table (which holds no
	 * embeddings, so it never needs a vector index).
	 */
	async compact(): Promise<OptimizeReport> {
		const report = await this.optimize({ force: true, create: true });
		await this.dropLegacyTables(report);
		const files = await this.tables.table(TableName.Files);
		if (files) {
			await files.optimize();
			report.tables.push({
				table: TableName.Files,
				rows: await files.countRows(),
				action: "optimized",
			});
		}
		return report;
	}

	/**
	 * Remove tables no longer part of the schema.
	 *
	 * Databases built before faceting was removed still carry a `vocab` table
	 * holding one embedding per corpus term — nothing reads it now, and at
	 * full embedding width that is real disk. Dropping it here means users
	 * reclaim the space by running the command they already run.
	 */
	private async dropLegacyTables(report: OptimizeReport): Promise<void> {
		const vocab = await this.tables.table(TableName.LegacyVocab);
		if (!vocab) return;
		const rows = await vocab.countRows();
		await this.tables.dropTable(TableName.LegacyVocab);
		report.tables.push({
			table: TableName.LegacyVocab,
			rows,
			action: "dropped",
		});
	}

	private async optimizeTable(
		name: string,
		table: Table,
		force: boolean,
		create: boolean,
	): Promise<TableOptimizeReport> {
		const rows = await table.countRows();

		// listIndices reports the columns each index covers, so this stays
		// correct if a scalar index is ever added alongside the vector one.
		const indices = await table.listIndices();
		const vectorIndex = indices.find((i) => i.columns.includes("vector"));

		if (!vectorIndex) {
			// The size guard is not overridable. `force` means "don't wait for
			// the tail to grow", not "cluster a table with too few vectors to
			// cluster" — IVF-PQ on a small table trains empty partitions and
			// degrades recall for no memory saving.
			if (rows < VectorIndexPolicy.MIN_ROWS_FOR_ANN) {
				return { table: name, rows, action: "skipped-small" };
			}
			if (!create) {
				return { table: name, rows, action: "needs-index" };
			}
			// numPartitions and numSubVectors are left to LanceDB, which
			// derives them from row count and dimensionality. Hard-coding them
			// would only reproduce that rule for dimensions already seen.
			await table.createIndex("vector", {
				config: Index.ivfPq({
					distanceType: VectorIndexPolicy.DISTANCE_TYPE,
				}),
				replace: true,
			});
			await table.optimize();
			return { table: name, rows, action: "created" };
		}

		const stats = await table.indexStats(vectorIndex.name);
		const unindexed = stats?.numUnindexedRows ?? 0;
		const indexed = stats?.numIndexedRows ?? 0;
		const tolerated = Math.max(
			VectorIndexPolicy.UNINDEXED_REINDEX_FLOOR,
			Math.floor(indexed * VectorIndexPolicy.UNINDEXED_REINDEX_RATIO),
		);

		if (!force && unindexed <= tolerated) {
			return { table: name, rows, action: "up-to-date", unindexed };
		}

		// optimize() both compacts fragments and folds the unindexed tail into
		// the existing index — no retraining from scratch.
		await table.optimize();
		return { table: name, rows, action: "optimized", unindexed };
	}

	/**
	 * Remove rows that should not be there: exact id duplicates (from
	 * concurrent unlocked indexing) and chunks whose file version no branch
	 * references any more. Survivors are rewritten into a fresh table, which is
	 * also what reclaims the disk the dropped rows held.
	 */
	async dedupe(): Promise<DedupeReport> {
		const table = await this.tables.table(TableName.Chunks);
		if (!table) {
			return { before: 0, after: 0, duplicateIds: 0, staleVersions: 0 };
		}
		const before = await table.countRows();

		// (filePath, fileHash) pairs any branch still references.
		const referenced = new Map<string, Set<string>>();
		for (const entry of await this.manifest.allEntries()) {
			const set = referenced.get(entry.filePath) ?? new Set<string>();
			set.add(entry.fileHash.toString());
			referenced.set(entry.filePath, set);
		}

		const kept: Record<string, unknown>[] = [];
		const seenIds = new Set<string>();
		let duplicateIds = 0;
		let staleVersions = 0;

		const total = before;
		const BATCH = 2000;
		for (let offset = 0; offset < total; offset += BATCH) {
			const rows = await table.query().limit(BATCH).offset(offset).toArray();
			if (rows.length === 0) break;
			for (const row of rows) {
				const id = row.id as string;
				if (seenIds.has(id)) {
					duplicateIds++;
					continue;
				}
				seenIds.add(id);

				const filePath = row.filePath as string;
				const fileHash = (row.fileHash as string) ?? "";
				// "" is the legacy wildcard — never stale.
				if (fileHash !== "" && !referenced.get(filePath)?.has(fileHash)) {
					staleVersions++;
					continue;
				}
				kept.push(this.toPlainRow(row));
			}
		}

		if (duplicateIds + staleVersions === 0) {
			return { before, after: before, duplicateIds, staleVersions };
		}

		await this.tables.dropTable(TableName.Chunks);
		if (kept.length > 0) {
			const { table: rebuilt, seeded } = await this.tables.tableOrCreate(
				TableName.Chunks,
				kept,
			);
			if (!seeded) await rebuilt.add(kept);
		}

		return { before, after: kept.length, duplicateIds, staleVersions };
	}

	async vectorIndexState(): Promise<VectorIndexState> {
		const table = await this.tables.table(TableName.Chunks);
		if (!table) {
			return { rows: 0, built: false, unindexed: 0, worthBuilding: false };
		}

		const rows = await table.countRows();
		const index = (await table.listIndices()).find((i) =>
			i.columns.includes("vector"),
		);
		if (!index) {
			return {
				rows,
				built: false,
				unindexed: rows,
				worthBuilding: rows >= VectorIndexPolicy.MIN_ROWS_FOR_ANN,
			};
		}

		const stats = await table.indexStats(index.name);
		return {
			rows,
			built: true,
			unindexed: stats?.numUnindexedRows ?? 0,
			worthBuilding: true,
		};
	}

	async reset(): Promise<void> {
		for (const name of [
			TableName.Chunks,
			TableName.Files,
			TableName.LegacyVocab,
		]) {
			await this.tables.dropTable(name);
		}
		this.manifest.invalidate();
	}

	/** Arrow rows carry typed arrays; LanceDB needs plain values to re-infer a schema. */
	private toPlainRow(row: Record<string, unknown>): Record<string, unknown> {
		const chunk = ChunkRepository.rowToChunk(row);
		return {
			id: row.id as string,
			filePath: chunk.location.filePath,
			startLine: chunk.location.startLine,
			endLine: chunk.location.endLine,
			type: chunk.type,
			name: chunk.name,
			content: chunk.content,
			context: chunk.context,
			hash: chunk.hash.toString(),
			fileHash: chunk.fileVersion.toStored(),
			vector: Array.from(row.vector as Iterable<number>),
		};
	}
}
