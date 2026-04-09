import { connect, type Table, type Connection } from "@lancedb/lancedb";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	statSync,
	writeFileSync,
	readFileSync,
	readdirSync,
	existsSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { IndexedChunk, SearchResult } from "./types.js";

const CHUNKS_TABLE = "chunks";
const FILES_TABLE = "files";
const DELETE_BATCH_SIZE = 50;

function buildInFilter(column: string, values: string[]): string {
	const escaped = values.map((v) => `'${v.replace(/'/g, "''")}'`);
	return `${column} IN (${escaped.join(", ")})`;
}

async function batchDelete(table: Table, column: string, values: string[]): Promise<void> {
	for (let i = 0; i < values.length; i += DELETE_BATCH_SIZE) {
		const batch = values.slice(i, i + DELETE_BATCH_SIZE);
		await table.delete(buildInFilter(column, batch));
	}
}

function git(cwd: string, ...args: string[]): string | undefined {
	try {
		return execSync(`git ${args.join(" ")}`, {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		})
			.toString()
			.trim();
	} catch {
		return undefined;
	}
}

/**
 * Resolve the project identity for a directory.
 *
 * For git repos: uses the remote origin URL as identity so that multiple
 * worktrees of the same repo share one index.
 *
 * For non-git directories: falls back to hashing the absolute path.
 *
 * Returns { id, root } where id is the string to hash for the DB path,
 * and root is the project root directory (git toplevel or cwd).
 */
export function resolveProject(cwd: string): { id: string; root: string; branch: string } {
	const absolute = resolve(cwd);

	const gitRoot = git(absolute, "rev-parse", "--show-toplevel");
	if (gitRoot) {
		const branch = git(gitRoot, "rev-parse", "--abbrev-ref", "HEAD") ?? "HEAD";
		const remoteUrl = git(gitRoot, "remote", "get-url", "origin");
		if (remoteUrl) {
			return { id: remoteUrl, root: gitRoot, branch };
		}
		// Git repo with no remote — use the git root path
		return { id: gitRoot, root: gitRoot, branch };
	}

	return { id: absolute, root: absolute, branch: "_default" };
}

function buildSlug(id: string, root: string): string {
	const hash = createHash("sha256").update(id).digest("hex").slice(0, 8);
	const parts = root.split("/").filter(Boolean);
	const slug = parts.slice(-2).join("-").replace(/[^a-zA-Z0-9_-]/g, "_");
	return `${slug}-${hash}`;
}

export function getDbPath(cwd: string): string {
	const { id, root } = resolveProject(cwd);
	return join(homedir(), ".local", "state", "lmgrep", buildSlug(id, root));
}

/**
 * Compute the DB path using the pre-git-aware scheme (absolute path hash).
 * Used by `lmgrep import` to find legacy indexes.
 */
export function getLegacyDbPath(cwd: string): string {
	const absolute = resolve(cwd);
	const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 6);
	const parts = absolute.split("/").filter(Boolean);
	const slug = parts.slice(-2).join("-").replace(/[^a-zA-Z0-9_-]/g, "_");
	return join(homedir(), ".local", "state", "lmgrep", `${slug}-${hash}`);
}

/**
 * Find the project root and compute the prefix (subdirectory offset).
 * For git repos, the root is the git toplevel. For non-git dirs, walks up
 * looking for an existing index.
 */
export function findIndexedAncestor(
	cwd: string,
): { root: string; prefix: string } | undefined {
	const absolute = resolve(cwd);
	const { root } = resolveProject(cwd);

	// For git repos, the root is always the git toplevel
	const dbPath = getDbPath(root);
	try {
		if (statSync(dbPath).isDirectory()) {
			const prefix =
				root === absolute ? "" : absolute.slice(root.length + 1);
			return { root, prefix };
		}
	} catch {
		// no index yet
	}

	// For non-git dirs, walk up looking for an ancestor with an index
	if (root === absolute) {
		let current = resolve(absolute, "..");
		while (true) {
			const ancestorDb = getDbPath(current);
			try {
				if (statSync(ancestorDb).isDirectory()) {
					const prefix = absolute.slice(current.length + 1);
					return { root: current, prefix };
				}
			} catch {
				// keep climbing
			}
			const parent = resolve(current, "..");
			if (parent === current) break;
			current = parent;
		}
	}

	return undefined;
}

// --- Project metadata ---

const METADATA_FILE = "lmgrep.json";

export interface ProjectMetadata {
	root: string;
	remote?: string;
	branch: string;
	indexedAt: string;
	/** Full model string used at index time (e.g. "openai:nomic-embed-text") */
	model?: string;
	/** Embedding vector dimensions */
	dimensions?: number;
}

/**
 * Extract the base model family name from a full model string.
 * Strips provider prefix (e.g. "openai:", "ollama:") and quantization/tag
 * suffixes (e.g. ":Q4_K_M", ":latest", ":fp16").
 *
 * Examples:
 *   "openai:nomic-embed-text"        → "nomic-embed-text"
 *   "ollama:nomic-embed-text:Q4_K_M" → "nomic-embed-text"
 *   "lmstudio:bge-large-en:fp16"     → "bge-large-en"
 *   "openai:text-embedding-3-small"   → "text-embedding-3-small"
 */
export function extractModelFamily(model: string): string {
	// Strip provider prefix (first colon-separated segment)
	const colonIdx = model.indexOf(":");
	if (colonIdx === -1) return model;
	const rest = model.slice(colonIdx + 1);

	// Strip quant/tag suffix: known patterns like Q4_K_M, Q8_0, fp16, latest, etc.
	// These appear as the last colon-separated segment
	const lastColon = rest.lastIndexOf(":");
	if (lastColon === -1) return rest;

	const suffix = rest.slice(lastColon + 1);
	// Match common quantization and tag patterns
	if (/^(Q\d|q\d|fp\d|f\d|latest|gguf|ggml)/i.test(suffix)) {
		return rest.slice(0, lastColon);
	}

	// Not a recognized suffix — keep the whole thing (could be part of model name)
	return rest;
}

export function writeProjectMetadata(
	cwd: string,
	extra?: { model?: string; dimensions?: number },
): void {
	const dbPath = getDbPath(cwd);
	const { id, root, branch } = resolveProject(cwd);
	const gitRoot = git(resolve(cwd), "rev-parse", "--show-toplevel");
	const remote = gitRoot
		? git(gitRoot, "remote", "get-url", "origin") ?? undefined
		: undefined;

	mkdirSync(dbPath, { recursive: true });

	// Preserve existing model/dimensions if not provided (don't overwrite baseline)
	const existing = readProjectMetadata(dbPath);
	const metadata: ProjectMetadata = {
		root,
		remote,
		branch,
		indexedAt: new Date().toISOString(),
		model: existing?.model ?? extra?.model,
		dimensions: existing?.dimensions ?? extra?.dimensions,
	};
	writeFileSync(join(dbPath, METADATA_FILE), JSON.stringify(metadata, null, 2));
}

export function readProjectMetadata(dbPath: string): ProjectMetadata | undefined {
	const metaPath = join(dbPath, METADATA_FILE);
	try {
		return JSON.parse(readFileSync(metaPath, "utf-8")) as ProjectMetadata;
	} catch {
		return undefined;
	}
}

/**
 * Scan all lmgrep indexes and return their metadata.
 */
export function discoverIndexedProjects(): Array<{
	dbPath: string;
	metadata: ProjectMetadata;
}> {
	const baseDir = join(homedir(), ".local", "state", "lmgrep");
	if (!existsSync(baseDir)) return [];

	const results: Array<{ dbPath: string; metadata: ProjectMetadata }> = [];
	for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dbPath = join(baseDir, entry.name);
		const metadata = readProjectMetadata(dbPath);
		if (metadata) {
			results.push({ dbPath, metadata });
		}
	}
	return results;
}

// --- DB-level write lock ---

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Acquire an exclusive write lock for a project's DB.
 * Returns true if the lock was acquired, false if another process holds it.
 */
export function acquireDbLock(cwd: string): boolean {
	const lockPath = `${getDbPath(cwd)}.lock`;
	if (existsSync(lockPath)) {
		try {
			const pid = Number.parseInt(
				readFileSync(lockPath, "utf-8").trim(),
				10,
			);
			if (isProcessAlive(pid)) return false;
		} catch {
			// stale lock, take over
		}
	}
	const dbPath = getDbPath(cwd);
	mkdirSync(dbPath, { recursive: true });
	writeFileSync(lockPath, `${process.pid}\n`);
	return true;
}

/**
 * Release the write lock for a project's DB.
 */
export function releaseDbLock(cwd: string): void {
	try {
		unlinkSync(`${getDbPath(cwd)}.lock`);
	} catch {}
}

/**
 * Check if a write lock is held by a live process.
 */
export function isDbLocked(cwd: string): boolean {
	const lockPath = `${getDbPath(cwd)}.lock`;
	if (!existsSync(lockPath)) return false;
	try {
		const pid = Number.parseInt(
			readFileSync(lockPath, "utf-8").trim(),
			10,
		);
		return isProcessAlive(pid);
	} catch {
		return false;
	}
}

// --- Running process discovery ---

export interface RunningProcess {
	pid: number;
	/** Process title from /proc/<pid>/comm (e.g. "lmgrep-mcp", "lmgrep") */
	processName: string;
	/** Full command line */
	cmdline: string;
	/** Kind of process: "mcp", "serve", or "cli" */
	kind: "mcp" | "serve" | "cli";
	/** Project root from the index metadata */
	projectRoot?: string;
	/** Whether this process is maintaining (watching) the index */
	watching: boolean;
}

function getProcessInfo(pid: number): { name: string; cmdline: string } | undefined {
	try {
		const name = readFileSync(`/proc/${pid}/comm`, "utf-8").trim();
		const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8")
			.replace(/\0/g, " ")
			.trim();
		return { name, cmdline };
	} catch {
		return undefined;
	}
}

function classifyProcess(info: { name: string; cmdline: string }): "mcp" | "serve" | "cli" {
	if (info.name === "lmgrep-mcp" || info.cmdline.includes("mcp")) return "mcp";
	if (info.cmdline.includes("serve")) return "serve";
	return "cli";
}

/**
 * Scan all lock files to find running lmgrep processes,
 * which indexes they hold, and whether they are watching for changes.
 */
export function discoverRunningProcesses(): RunningProcess[] {
	const baseDir = join(homedir(), ".local", "state", "lmgrep");
	if (!existsSync(baseDir)) return [];

	const results: RunningProcess[] = [];
	const seen = new Set<number>();

	for (const entry of readdirSync(baseDir)) {
		if (!entry.endsWith(".lock")) continue;

		const lockPath = join(baseDir, entry);
		let pid: number;
		try {
			pid = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
		} catch {
			continue;
		}

		if (!isProcessAlive(pid) || seen.has(pid)) continue;
		seen.add(pid);

		const info = getProcessInfo(pid);
		if (!info) continue;

		const kind = classifyProcess(info);

		// Resolve which project this lock belongs to
		const dbDir = entry.slice(0, -".lock".length);
		const dbPath = join(baseDir, dbDir);
		const metadata = readProjectMetadata(dbPath);

		results.push({
			pid,
			processName: info.name,
			cmdline: info.cmdline,
			kind,
			projectRoot: metadata?.root,
			// MCP and serve processes watch; plain CLI invocations don't
			watching: kind === "mcp" || kind === "serve",
		});
	}

	return results;
}

export class Store {
	private db: Connection | undefined;
	private chunksTable: Table | undefined;
	private filesTable: Table | undefined;

	constructor(
		private readonly dbPath: string,
		private readonly branch: string = "_default",
	) {}

	static forProject(cwd: string): Store {
		const { branch } = resolveProject(cwd);
		return new Store(getDbPath(cwd), branch);
	}

	// --- Connection ---

	private async connection(): Promise<Connection> {
		if (this.db) return this.db;
		mkdirSync(this.dbPath, { recursive: true });
		this.db = await connect(this.dbPath);
		return this.db;
	}

	private async openChunks(): Promise<Table | undefined> {
		if (this.chunksTable) return this.chunksTable;
		const conn = await this.connection();
		const tables = await conn.tableNames();
		if (tables.includes(CHUNKS_TABLE)) {
			this.chunksTable = await conn.openTable(CHUNKS_TABLE);
			return this.chunksTable;
		}
		return undefined;
	}

	private async openFiles(): Promise<Table | undefined> {
		if (this.filesTable) return this.filesTable;
		const conn = await this.connection();
		const tables = await conn.tableNames();
		if (tables.includes(FILES_TABLE)) {
			this.filesTable = await conn.openTable(FILES_TABLE);
			return this.filesTable;
		}
		return undefined;
	}

	// --- Chunks ---

	async addChunks(chunks: IndexedChunk[]): Promise<void> {
		if (chunks.length === 0) return;

		const conn = await this.connection();
		const records = chunks.map((c) => ({
			id: c.id,
			filePath: c.filePath,
			startLine: c.startLine,
			endLine: c.endLine,
			type: c.type,
			name: c.name,
			content: c.content,
			context: c.context,
			hash: c.hash,
			vector: c.vector,
		}));

		const tables = await conn.tableNames();
		if (tables.includes(CHUNKS_TABLE)) {
			const t = await conn.openTable(CHUNKS_TABLE);
			this.chunksTable = t;
			await t.add(records);
		} else {
			this.chunksTable = await conn.createTable(CHUNKS_TABLE, records);
		}
	}

	/**
	 * Delete chunks for files that are no longer referenced by ANY branch.
	 * If another branch still has a file hash entry for a given path,
	 * the chunks are kept (they're shared via content-addressing).
	 */
	async deleteChunksByFiles(filePaths: string[]): Promise<void> {
		const t = await this.openChunks();
		if (!t || filePaths.length === 0) return;

		const filesTable = await this.openFiles();
		if (!filesTable) {
			// No files table means no other branches — safe to delete all
			await batchDelete(t, "filePath", filePaths);
			return;
		}

		// Find which files are still referenced by other branches
		const escaped = this.branch.replace(/'/g, "''");
		const stillReferenced = new Set<string>();
		for (let i = 0; i < filePaths.length; i += DELETE_BATCH_SIZE) {
			const batch = filePaths.slice(i, i + DELETE_BATCH_SIZE);
			const pathFilter = buildInFilter("filePath", batch);
			const refs = await filesTable
				.query()
				.where(`branch != '${escaped}' AND ${pathFilter}`)
				.select(["filePath"])
				.toArray();
			for (const r of refs) {
				stillReferenced.add(r.filePath as string);
			}
		}

		// Only delete chunks for files not referenced by other branches
		const toDelete = filePaths.filter((fp) => !stillReferenced.has(fp));
		if (toDelete.length > 0) {
			await batchDelete(t, "filePath", toDelete);
		}
	}

	async search(
		queryVector: number[],
		limit = 25,
		filePrefix?: string,
		typeFilter?: string[],
	): Promise<SearchResult[]> {
		const t = await this.openChunks();
		if (!t) {
			throw new Error("No index found. Run `lmgrep index` first.");
		}

		let query = t.search(queryVector).limit(limit);

		const conditions: string[] = [];
		if (filePrefix) {
			conditions.push(
				`filePath LIKE '${filePrefix.replace(/'/g, "''")}%'`,
			);
		}
		if (typeFilter && typeFilter.length > 0) {
			const escaped = typeFilter.map(
				(t) => `'${t.replace(/'/g, "''")}'`,
			);
			conditions.push(`type IN (${escaped.join(", ")})`);
		}
		if (conditions.length > 0) {
			query = query.where(conditions.join(" AND "));
		}

		const results = await query.toArray();

		return results.map((r) => ({
			filePath: r.filePath as string,
			startLine: r.startLine as number,
			endLine: r.endLine as number,
			type: r.type as string,
			name: r.name as string,
			content: r.content as string,
			context: r.context as string,
			score: r._distance != null ? 1 - (r._distance as number) : 0,
		}));
	}

	async getIndexedFiles(): Promise<Map<string, string[]>> {
		const t = await this.openChunks();
		if (!t) return new Map();

		const rows = await t.query().select(["filePath", "hash"]).toArray();
		const map = new Map<string, string[]>();
		for (const row of rows) {
			const fp = row.filePath as string;
			const hash = row.hash as string;
			const existing = map.get(fp) ?? [];
			existing.push(hash);
			map.set(fp, existing);
		}
		return map;
	}

	async getIndexedHashes(): Promise<Set<string>> {
		const t = await this.openChunks();
		if (!t) return new Set();

		const rows = await t.query().select(["hash"]).toArray();
		return new Set(rows.map((r) => r.hash as string));
	}

	/**
	 * Given a set of chunk hashes, return those that already exist in the
	 * chunks table. Runs as batched IN() queries in the DB.
	 */
	async filterExistingChunkHashes(hashes: string[]): Promise<Set<string>> {
		const t = await this.openChunks();
		if (!t || hashes.length === 0) return new Set();

		const existing = new Set<string>();
		const unique = [...new Set(hashes)];
		for (let i = 0; i < unique.length; i += DELETE_BATCH_SIZE) {
			const batch = unique.slice(i, i + DELETE_BATCH_SIZE);
			const filter = buildInFilter("hash", batch);
			const rows = await t
				.query()
				.where(filter)
				.select(["hash"])
				.toArray();
			for (const r of rows) {
				existing.add(r.hash as string);
			}
		}
		return existing;
	}

	async chunkCount(): Promise<number> {
		const t = await this.openChunks();
		if (!t) return 0;
		return await t.countRows();
	}

	// --- File hashes (change detection) ---

	async getFileHashes(): Promise<Map<string, string>> {
		const t = await this.openFiles();
		if (!t) return new Map();

		const escaped = this.branch.replace(/'/g, "''");
		const rows = await t
			.query()
			.where(`branch = '${escaped}'`)
			.select(["filePath", "fileHash"])
			.toArray();
		const map = new Map<string, string>();
		for (const row of rows) {
			map.set(row.filePath as string, row.fileHash as string);
		}
		return map;
	}

	/**
	 * Given a set of file hashes, return those that already exist in the
	 * files table on ANY branch. The query runs in the DB, not in JS.
	 */
	async filterKnownFileHashes(hashes: string[]): Promise<Set<string>> {
		const t = await this.openFiles();
		if (!t || hashes.length === 0) return new Set();

		const known = new Set<string>();
		for (let i = 0; i < hashes.length; i += DELETE_BATCH_SIZE) {
			const batch = hashes.slice(i, i + DELETE_BATCH_SIZE);
			const filter = buildInFilter("fileHash", batch);
			const rows = await t
				.query()
				.where(filter)
				.select(["fileHash"])
				.toArray();
			for (const r of rows) {
				known.add(r.fileHash as string);
			}
		}
		return known;
	}

	async upsertFileHashes(
		entries: Array<{ filePath: string; fileHash: string }>,
	): Promise<void> {
		if (entries.length === 0) return;

		const records = entries.map((e) => ({
			...e,
			branch: this.branch,
		}));

		const conn = await this.connection();
		const tables = await conn.tableNames();

		if (tables.includes(FILES_TABLE)) {
			const t = await conn.openTable(FILES_TABLE);
			this.filesTable = t;
			// Delete existing entries for this branch + these file paths
			const escaped = this.branch.replace(/'/g, "''");
			for (let i = 0; i < entries.length; i += DELETE_BATCH_SIZE) {
				const batch = entries.slice(i, i + DELETE_BATCH_SIZE);
				const pathFilter = buildInFilter(
					"filePath",
					batch.map((e) => e.filePath),
				);
				await t.delete(`branch = '${escaped}' AND ${pathFilter}`);
			}
			await t.add(records);
		} else {
			this.filesTable = await conn.createTable(FILES_TABLE, records);
		}
	}

	async deleteFileHashes(filePaths: string[]): Promise<void> {
		const t = await this.openFiles();
		if (!t || filePaths.length === 0) return;
		const escaped = this.branch.replace(/'/g, "''");
		for (let i = 0; i < filePaths.length; i += DELETE_BATCH_SIZE) {
			const batch = filePaths.slice(i, i + DELETE_BATCH_SIZE);
			const pathFilter = buildInFilter("filePath", batch);
			await t.delete(`branch = '${escaped}' AND ${pathFilter}`);
		}
	}

	// --- Admin ---

	async *streamAllChunks(
		batchSize: number,
	): AsyncGenerator<Record<string, unknown>[]> {
		const t = await this.openChunks();
		if (!t) return;

		const total = await t.countRows();
		for (let offset = 0; offset < total; offset += batchSize) {
			const rows = await t.query().limit(batchSize).offset(offset).toArray();
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
				vector: Array.from(r.vector as Iterable<number>),
			}));
		}
	}

	async getAllFileEntries(): Promise<
		Array<{ filePath: string; fileHash: string; branch: string }>
	> {
		const t = await this.openFiles();
		if (!t) return [];
		const rows = await t.query().toArray();
		return rows.map((r) => ({
			filePath: r.filePath as string,
			fileHash: r.fileHash as string,
			branch: (r.branch as string) ?? this.branch,
		}));
	}

	async reset(): Promise<void> {
		const conn = await this.connection();
		const tables = await conn.tableNames();
		if (tables.includes(CHUNKS_TABLE)) await conn.dropTable(CHUNKS_TABLE);
		if (tables.includes(FILES_TABLE)) await conn.dropTable(FILES_TABLE);
		this.chunksTable = undefined;
		this.filesTable = undefined;
	}

	async compact(): Promise<void> {
		const t = await this.openChunks();
		if (t) await t.optimize();
		const f = await this.openFiles();
		if (f) await f.optimize();
	}

	/**
	 * Import all chunks and file hashes from another Store's database.
	 * Returns { chunks, files } counts of imported records.
	 */
	async importFrom(
		sourcePath: string,
	): Promise<{ chunks: number; files: number }> {
		const sourceConn = await connect(sourcePath);
		const sourceTables = await sourceConn.tableNames();
		let chunks = 0;
		let files = 0;

		if (sourceTables.includes(CHUNKS_TABLE)) {
			const sourceChunks = await sourceConn.openTable(CHUNKS_TABLE);
			const rawChunkRows = await sourceChunks.query().toArray();
			if (rawChunkRows.length > 0) {
				// Convert Arrow typed arrays to plain JS objects so LanceDB can
				// infer the schema when creating a new table.
				const rows = rawChunkRows.map((r) => ({
					id: r.id,
					filePath: r.filePath,
					startLine: r.startLine,
					endLine: r.endLine,
					type: r.type,
					name: r.name,
					content: r.content,
					context: r.context,
					hash: r.hash,
					vector: Array.from(r.vector as Iterable<number>),
				}));
				const conn = await this.connection();
				const destTables = await conn.tableNames();
				if (destTables.includes(CHUNKS_TABLE)) {
					const t = await conn.openTable(CHUNKS_TABLE);
					this.chunksTable = t;
					await t.add(rows);
				} else {
					this.chunksTable = await conn.createTable(CHUNKS_TABLE, rows);
				}
				chunks = rows.length;
			}
		}

		if (sourceTables.includes(FILES_TABLE)) {
			const sourceFiles = await sourceConn.openTable(FILES_TABLE);
			const rawRows = await sourceFiles.query().toArray();
			if (rawRows.length > 0) {
				// Ensure branch column exists (legacy DBs won't have it)
				const rows = rawRows.map((r) => ({
					filePath: r.filePath,
					fileHash: r.fileHash,
					branch: r.branch ?? this.branch,
				}));
				const conn = await this.connection();
				const destTables = await conn.tableNames();
				if (destTables.includes(FILES_TABLE)) {
					const t = await conn.openTable(FILES_TABLE);
					this.filesTable = t;
					await t.add(rows);
				} else {
					this.filesTable = await conn.createTable(FILES_TABLE, rows);
				}
				files = rows.length;
			}
		}

		return { chunks, files };
	}

	async close(): Promise<void> {
		this.chunksTable = undefined;
		this.filesTable = undefined;
		this.db = undefined;
	}
}
