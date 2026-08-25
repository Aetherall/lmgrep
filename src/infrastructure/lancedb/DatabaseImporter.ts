import { connect } from "@lancedb/lancedb";
import type { Branch } from "../../domain/project/Branch.js";
import { type LanceTables, TableName } from "./LanceTables.js";

export interface ImportResult {
	chunks: number;
	files: number;
}

/**
 * Copies chunks and manifest rows out of another lmgrep database.
 *
 * Rows move verbatim, embeddings included — the point of importing is to avoid
 * re-embedding, so re-deriving anything here would defeat it. The source must
 * therefore have been built with a compatible model; the caller reports the
 * source's model so the user can check.
 */
export class DatabaseImporter {
	constructor(
		private readonly tables: LanceTables,
		private readonly branch: Branch,
	) {}

	async importFrom(sourcePath: string): Promise<ImportResult> {
		const source = await connect(sourcePath);
		const available = await source.tableNames();

		return {
			chunks: available.includes(TableName.Chunks)
				? await this.copyChunks(source)
				: 0,
			files: available.includes(TableName.Files)
				? await this.copyFiles(source)
				: 0,
		};
	}

	private async copyChunks(
		source: Awaited<ReturnType<typeof connect>>,
	): Promise<number> {
		const rows = await (await source.openTable(TableName.Chunks))
			.query()
			.toArray();
		if (rows.length === 0) return 0;

		// Arrow hands back typed arrays; LanceDB needs plain values to infer a
		// schema when the destination table does not exist yet.
		const records = rows.map((r) => ({
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
			vector: Array.from(r.vector as Iterable<number>),
		}));

		const { table, seeded } = await this.tables.tableOrCreate(
			TableName.Chunks,
			records,
		);
		if (!seeded) await table.add(records);
		return records.length;
	}

	private async copyFiles(
		source: Awaited<ReturnType<typeof connect>>,
	): Promise<number> {
		const rows = await (await source.openTable(TableName.Files))
			.query()
			.toArray();
		if (rows.length === 0) return 0;

		// Legacy databases predate the branch column; adopt ours for those.
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
		return records.length;
	}
}
