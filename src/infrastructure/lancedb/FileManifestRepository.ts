import { ContentHash } from "../../domain/corpus/ContentHash.js";
import {
	FileManifest,
	type SourceFile,
} from "../../domain/corpus/SourceFile.js";
import type {
	FileManifestRepositoryPort,
	ManifestEntry,
} from "../../domain/ports/FileManifestRepositoryPort.js";
import { Branch } from "../../domain/project/Branch.js";
import { LanceTables, TableName } from "./LanceTables.js";

interface FileRow extends Record<string, unknown> {
	filePath: string;
	fileHash: string;
	branch: string;
}

/**
 * The branch-scoped file manifest in LanceDB.
 *
 * The current branch's manifest is cached because every search consults it to
 * scope results, and re-reading it per query would dominate search latency.
 * Anything that writes the manifest must {@link invalidate}.
 */
export class FileManifestRepository implements FileManifestRepositoryPort {
	private cached: FileManifest | undefined;

	constructor(
		private readonly tables: LanceTables,
		private readonly branch: Branch,
	) {}

	async current(): Promise<FileManifest> {
		const table = await this.tables.table(TableName.Files);
		if (!table) return FileManifest.empty();

		const rows = await table
			.query()
			.where(`branch = '${this.branch.toSqlLiteral()}'`)
			.select(["filePath", "fileHash"])
			.toArray();

		return FileManifest.fromEntries(
			rows.map((r) => [
				r.filePath as string,
				ContentHash.fromStored(r.fileHash as string),
			]),
		);
	}

	async branchVersions(): Promise<FileManifest | undefined> {
		if (this.cached) return this.cached;
		const table = await this.tables.table(TableName.Files);
		if (!table) return undefined;
		this.cached = await this.current();
		return this.cached;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	async upsert(entries: SourceFile[]): Promise<void> {
		if (entries.length === 0) return;

		const records: FileRow[] = entries.map((e) => ({
			filePath: e.path,
			fileHash: e.hash.toString(),
			branch: this.branch.toString(),
		}));

		const { table, seeded } = await this.tables.tableOrCreate(
			TableName.Files,
			records,
		);
		if (seeded) {
			this.invalidate();
			return;
		}

		// Replace this branch's rows for these paths, leaving other branches'
		// rows for the same paths untouched.
		const paths = records.map((r) => r.filePath);
		for (let i = 0; i < paths.length; i += LanceTables.FILTER_BATCH_SIZE) {
			const batch = paths.slice(i, i + LanceTables.FILTER_BATCH_SIZE);
			await table.delete(
				`branch = '${this.branch.toSqlLiteral()}' AND ${LanceTables.inFilter("filePath", batch)}`,
			);
		}
		await table.add(records);
		this.invalidate();
	}

	async deleteFiles(filePaths: string[]): Promise<void> {
		const table = await this.tables.table(TableName.Files);
		if (!table || filePaths.length === 0) return;
		for (let i = 0; i < filePaths.length; i += LanceTables.FILTER_BATCH_SIZE) {
			const batch = filePaths.slice(i, i + LanceTables.FILTER_BATCH_SIZE);
			await table.delete(
				`branch = '${this.branch.toSqlLiteral()}' AND ${LanceTables.inFilter("filePath", batch)}`,
			);
		}
		this.invalidate();
	}

	/**
	 * Which of these file versions any branch has already indexed. A hit means
	 * the content is embedded, so the file can be registered on this branch
	 * without re-chunking it.
	 */
	async knownHashes(hashes: ContentHash[]): Promise<Set<string>> {
		const table = await this.tables.table(TableName.Files);
		if (!table || hashes.length === 0) return new Set();
		return LanceTables.selectIn(
			table,
			"fileHash",
			hashes.map((h) => h.toString()),
		);
	}

	async allEntries(): Promise<ManifestEntry[]> {
		const table = await this.tables.table(TableName.Files);
		if (!table) return [];
		const rows = await table.query().toArray();
		return rows.map((r) => ({
			filePath: r.filePath as string,
			fileHash: ContentHash.fromStored(r.fileHash as string),
			branch: Branch.of(r.branch as string),
		}));
	}

	async storedBranches(): Promise<string[]> {
		const table = await this.tables.table(TableName.Files);
		if (!table) return [];
		const rows = await table.query().select(["branch"]).toArray();
		return [...new Set(rows.map((r) => r.branch as string))];
	}

	async deleteBranch(branch: string): Promise<void> {
		const table = await this.tables.table(TableName.Files);
		if (!table) return;
		await table.delete(`branch = '${LanceTables.quote(branch)}'`);
		this.invalidate();
	}

	/** Seed this branch's manifest from another's — used on a new branch. */
	async copyFromBranch(sourceBranch: string): Promise<number> {
		const table = await this.tables.table(TableName.Files);
		if (!table) return 0;

		const rows = await table
			.query()
			.where(`branch = '${LanceTables.quote(sourceBranch)}'`)
			.select(["filePath", "fileHash"])
			.toArray();
		if (rows.length === 0) return 0;

		const records: FileRow[] = rows.map((r) => ({
			filePath: r.filePath as string,
			fileHash: r.fileHash as string,
			branch: this.branch.toString(),
		}));
		await table.add(records);
		this.invalidate();
		return records.length;
	}
}
