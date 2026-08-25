import type { Branch } from "../../domain/project/Branch.js";
import { type LanceTables, TableName } from "./LanceTables.js";

/** A manifest row as it travels between peers. */
export interface ManifestRow {
	filePath: string;
	fileHash: string;
	branch: string;
}

/**
 * Row-level access to the tables, for replication between databases.
 *
 * Peer sharing copies rows verbatim — embeddings included, since avoiding
 * re-embedding is the entire point — so it works below the domain model rather
 * than through it. Keeping that access behind this one class means the rest of
 * the system never sees raw rows.
 */
export class RowReplication {
	constructor(
		private readonly tables: LanceTables,
		private readonly branch: Branch,
	) {}

	async chunkCount(): Promise<number> {
		const table = await this.tables.table(TableName.Chunks);
		return table ? table.countRows() : 0;
	}

	/** Stream chunk rows in pages, so a large index never loads at once. */
	async *streamChunkRows(
		batchSize: number,
	): AsyncGenerator<Record<string, unknown>[]> {
		const table = await this.tables.table(TableName.Chunks);
		if (!table) return;

		const total = await table.countRows();
		for (let offset = 0; offset < total; offset += batchSize) {
			const rows = await table
				.query()
				.limit(batchSize)
				.offset(offset)
				.toArray();
			if (rows.length === 0) break;
			yield rows.map((r) => ({
				id: r.id,
				filePath: r.filePath,
				startLine: r.startLine,
				endLine: r.endLine,
				type: r.type,
				name: r.name,
				content: r.content,
				context: r.context,
				hash: r.hash,
				fileHash: (r.fileHash as string) ?? "",
				// Arrow typed arrays do not survive JSON; send plain numbers.
				vector: Array.from(r.vector as Iterable<number>),
			}));
		}
	}

	async allManifestRows(): Promise<ManifestRow[]> {
		const table = await this.tables.table(TableName.Files);
		if (!table) return [];
		const rows = await table.query().toArray();
		return rows.map((r) => ({
			filePath: r.filePath as string,
			fileHash: r.fileHash as string,
			branch: (r.branch as string) ?? this.branch.toString(),
		}));
	}

	async addChunkRows(rows: Record<string, unknown>[]): Promise<void> {
		if (rows.length === 0) return;
		const { table, seeded } = await this.tables.tableOrCreate(
			TableName.Chunks,
			rows,
		);
		if (!seeded) await table.add(rows);
	}

	async addManifestRows(rows: ManifestRow[]): Promise<void> {
		if (rows.length === 0) return;
		const records = rows.map((r) => ({
			filePath: r.filePath,
			fileHash: r.fileHash,
			branch: r.branch ?? this.branch.toString(),
		}));
		const { table, seeded } = await this.tables.tableOrCreate(
			TableName.Files,
			records,
		);
		if (!seeded) await table.add(records);
	}
}
