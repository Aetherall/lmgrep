import { Chunk } from "../../domain/corpus/Chunk.js";
import { CodeLocation } from "../../domain/corpus/CodeLocation.js";
import { ContentHash } from "../../domain/corpus/ContentHash.js";
import { FileVersion } from "../../domain/corpus/FileVersion.js";
import type { Vector } from "../../domain/corpus/Vector.js";
import type {
	ChunkQuery,
	ChunkRepositoryPort,
	ChunkText,
	EmbeddedChunk,
} from "../../domain/ports/ChunkRepositoryPort.js";
import type { FileManifestRepositoryPort } from "../../domain/ports/FileManifestRepositoryPort.js";
import type { Branch } from "../../domain/project/Branch.js";
import { Hit } from "../../domain/retrieval/Hit.js";
import { HitList } from "../../domain/retrieval/HitList.js";
import { LanceTables, TableName } from "./LanceTables.js";
import { SEARCH_COLUMNS, VectorIndexPolicy } from "./VectorIndexPolicy.js";

/** A chunk row as stored. */
interface ChunkRow extends Record<string, unknown> {
	id: string;
	filePath: string;
	startLine: number;
	endLine: number;
	type: string;
	name: string;
	content: string;
	context: string;
	hash: string;
	fileHash: string;
	vector: number[];
}

/**
 * Embedded chunks in LanceDB.
 *
 * Branch scoping lives here because it is a property of how chunks are stored:
 * they are shared across branches by content hash, so a query must intersect
 * them with the manifest of file versions the branch actually references.
 */
export class ChunkRepository implements ChunkRepositoryPort {
	constructor(
		private readonly tables: LanceTables,
		private readonly manifest: FileManifestRepositoryPort,
		private readonly branch: Branch,
	) {}

	async add(chunks: EmbeddedChunk[]): Promise<void> {
		if (chunks.length === 0) return;
		const records = chunks.map(({ chunk, vector }) =>
			this.toRow(chunk, vector),
		);
		const { table, seeded } = await this.tables.tableOrCreate(
			TableName.Chunks,
			records,
		);
		if (!seeded) await table.add(records);
	}

	async search(query: ChunkQuery): Promise<HitList> {
		const table = await this.tables.table(TableName.Chunks);
		if (!table) {
			throw new Error("No index found. Run `lmgrep index` first.");
		}

		const versions = query.scopeToBranch
			? await this.manifest.branchVersions()
			: undefined;

		// Over-fetch: branch/version filtering and dedup both discard rows, so
		// pull extra to still return `limit` distinct results.
		const fetchLimit = versions ? query.limit * 3 : query.limit * 2;

		let builder = table
			.query()
			.nearestTo(query.vector.toArray())
			.limit(fetchLimit)
			.refineFactor(VectorIndexPolicy.REFINE_FACTOR)
			.select([...SEARCH_COLUMNS]);

		const predicate = this.buildPredicate(query);
		if (predicate) builder = builder.where(predicate);

		const rows = await builder.toArray();
		let hits = HitList.of(rows.map((r) => this.toHit(r)));

		if (versions) {
			hits = hits.filtered((h) =>
				h.fileVersion.matches(versions.versionOf(h.location.filePath)),
			);
		}

		return hits.deduplicated().takeAtMost(query.limit);
	}

	/**
	 * Delete chunks for files no longer referenced by ANY branch. A path still
	 * present in another branch's manifest keeps its chunks — they are shared
	 * by content, so deleting them would blank that branch's results.
	 */
	async deleteByFiles(filePaths: string[]): Promise<void> {
		const table = await this.tables.table(TableName.Chunks);
		if (!table || filePaths.length === 0) return;

		const entries = await this.manifest.allEntries();
		const referencedElsewhere = new Set(
			entries
				.filter((e) => !e.branch.equals(this.branch))
				.map((e) => e.filePath),
		);

		const toDelete = filePaths.filter((p) => !referencedElsewhere.has(p));
		if (toDelete.length > 0) {
			await LanceTables.deleteIn(table, "filePath", toDelete);
		}
	}

	async existingHashes(hashes: ContentHash[]): Promise<Set<string>> {
		const table = await this.tables.table(TableName.Chunks);
		if (!table || hashes.length === 0) return new Set();
		const unique = [...new Set(hashes.map((h) => h.toString()))];
		return LanceTables.selectIn(table, "hash", unique);
	}

	async count(): Promise<number> {
		const table = await this.tables.table(TableName.Chunks);
		return table ? table.countRows() : 0;
	}

	async hashesByFile(): Promise<Map<string, string[]>> {
		const table = await this.tables.table(TableName.Chunks);
		if (!table) return new Map();
		const rows = await table.query().select(["filePath", "hash"]).toArray();
		const map = new Map<string, string[]>();
		for (const row of rows) {
			const fp = row.filePath as string;
			const existing = map.get(fp) ?? [];
			existing.push(row.hash as string);
			map.set(fp, existing);
		}
		return map;
	}

	async allHashes(): Promise<Set<string>> {
		const table = await this.tables.table(TableName.Chunks);
		if (!table) return new Set();
		const rows = await table.query().select(["hash"]).toArray();
		return new Set(rows.map((r) => r.hash as string));
	}

	async *streamTexts(batchSize = 1000): AsyncGenerator<ChunkText[]> {
		const table = await this.tables.table(TableName.Chunks);
		if (!table) return;
		const rows = await table.query().select(["name", "content"]).toArray();
		for (let i = 0; i < rows.length; i += batchSize) {
			yield rows.slice(i, i + batchSize).map((r) => ({
				name: (r.name as string) ?? "",
				content: (r.content as string) ?? "",
			}));
		}
	}

	private buildPredicate(query: ChunkQuery): string | undefined {
		const conditions: string[] = [];
		if (query.filePrefix) {
			conditions.push(
				`filePath LIKE '${LanceTables.quote(query.filePrefix)}%'`,
			);
		}
		if (query.types && query.types.length > 0) {
			const escaped = query.types.map((t) => `'${LanceTables.quote(t)}'`);
			conditions.push(`type IN (${escaped.join(", ")})`);
		}
		return conditions.length > 0 ? conditions.join(" AND ") : undefined;
	}

	private toRow(chunk: Chunk, vector: Vector): ChunkRow {
		return {
			id: chunk.id,
			filePath: chunk.location.filePath,
			startLine: chunk.location.startLine,
			endLine: chunk.location.endLine,
			type: chunk.type,
			name: chunk.name,
			content: chunk.content,
			context: chunk.context,
			hash: chunk.hash.toString(),
			fileHash: chunk.fileVersion.toStored(),
			vector: vector.toArray(),
		};
	}

	private toHit(row: Record<string, unknown>): Hit {
		const distance = row._distance as number | null | undefined;
		return new Hit(
			row.id as string,
			new CodeLocation(
				row.filePath as string,
				row.startLine as number,
				row.endLine as number,
			),
			row.type as string,
			row.name as string,
			row.content as string,
			row.context as string,
			distance != null ? 1 - distance : 0,
			FileVersion.fromStored(row.fileHash as string | undefined),
		);
	}

	/** Rebuild a domain Chunk from a stored row — used by import and dedup. */
	static rowToChunk(row: Record<string, unknown>): Chunk {
		return new Chunk({
			location: new CodeLocation(
				row.filePath as string,
				row.startLine as number,
				row.endLine as number,
			),
			type: row.type as string,
			name: row.name as string,
			content: row.content as string,
			context: row.context as string,
			hash: ContentHash.fromStored(row.hash as string),
			fileVersion: FileVersion.fromStored(row.fileHash as string | undefined),
		});
	}
}
