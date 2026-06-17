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
const VOCAB_TABLE = "vocab";
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

interface DedupableRow {
	id: string;
	filePath: string;
	startLine: number;
	endLine: number;
}

/**
 * Remove redundant search rows. Two passes, assuming `rows` is already in
 * best-first order (ANN returns ascending distance = descending score):
 *
 *  1. Exact duplicates by chunk id — collapses identical rows produced by
 *     concurrent unlocked indexing (same filePath:row:contentHash).
 *  2. Overlapping line ranges within the same file — collapses the
 *     fallback chunker's sliding-window overlap (and any parent/child or
 *     near-duplicate spans), keeping the highest-scoring chunk of each
 *     overlapping cluster. Tree-sitter chunks are node-bounded and don't
 *     overlap, so this only ever drops genuine near-duplicates.
 */
function dedupeRows<T extends DedupableRow>(rows: T[]): T[] {
	const seenIds = new Set<string>();
	const keptRanges = new Map<string, Array<[number, number]>>();
	const out: T[] = [];

	for (const r of rows) {
		if (seenIds.has(r.id)) continue;
		seenIds.add(r.id);

		const ranges = keptRanges.get(r.filePath);
		if (ranges) {
			const overlaps = ranges.some(
				([s, e]) => r.startLine <= e && s <= r.endLine,
			);
			if (overlaps) continue;
			ranges.push([r.startLine, r.endLine]);
		} else {
			keptRanges.set(r.filePath, [[r.startLine, r.endLine]]);
		}
		out.push(r);
	}

	return out;
}

/**
 * Legacy indexes (pre branch-scoping) have a `files` table without a `branch`
 * column. Detect and backfill it with the current branch so queries that filter
 * by branch keep working.
 */
async function migrateBranchColumn(table: Table, currentBranch: string): Promise<void> {
	const schema = await table.schema();
	if (schema.fields.some((f) => f.name === "branch")) return;
	const escaped = currentBranch.replace(/'/g, "''");
	await table.addColumns([
		{ name: "branch", valueSql: `CAST('${escaped}' AS STRING)` },
	]);
}

/**
 * Legacy chunk tables (pre version-scoping) have no `fileHash` column. Backfill
 * it with "" — the empty string is treated as a wildcard at search time so
 * legacy chunks keep appearing until the file is re-indexed and gets a real
 * file-version hash.
 */
async function migrateFileHashColumn(table: Table): Promise<void> {
	const schema = await table.schema();
	if (schema.fields.some((f) => f.name === "fileHash")) return;
	await table.addColumns([
		{ name: "fileHash", valueSql: `CAST('' AS STRING)` },
	]);
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

function slugifyId(id: string): string {
	// Strip git URL scheme and trailing .git so worktrees of the same repo
	// produce the same human-readable prefix regardless of the worktree path.
	// git@host:user/repo.git → user/repo
	// https://host/user/repo.git → host/user/repo (we'll take the last two)
	// /abs/path/to/project → path/to/project (we'll take the last two)
	let s = id.replace(/\.git$/, "");
	const scpMatch = s.match(/^[^@]+@[^:]+:(.+)$/);
	if (scpMatch) {
		s = scpMatch[1];
	} else {
		s = s.replace(/^[a-z]+:\/\/[^/]+\//, "");
	}
	const parts = s.split("/").filter(Boolean);
	return parts.slice(-2).join("-").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function buildSlug(id: string): string {
	const hash = createHash("sha256").update(id).digest("hex").slice(0, 8);
	return `${slugifyId(id)}-${hash}`;
}

export function getDbPath(cwd: string): string {
	const { id } = resolveProject(cwd);
	return join(homedir(), ".local", "state", "lmgrep", buildSlug(id));
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

// --- Per-build write mutex ---
//
// The `.lock` maintainer lock (above) is held for a watcher/serve process's
// whole lifetime and doubles as a liveness registry for `lmgrep status`. It
// cannot also serve as a write mutex, because then a one-shot `lmgrep index`
// could never run while a watcher is up. This separate `.writelock` is a
// short-lived mutex acquired around each build() so that the watcher and an
// ad-hoc `lmgrep index` serialize their writes instead of racing into
// duplicate rows. Named `.writelock` (not `.write.lock`) so it does not match
// the `.lock` suffix scan in discoverRunningProcesses.

function writeLockPath(cwd: string): string {
	return `${getDbPath(cwd)}.writelock`;
}

function tryAcquireWriteLock(cwd: string): boolean {
	const lockPath = writeLockPath(cwd);
	if (existsSync(lockPath)) {
		try {
			const pid = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
			if (isProcessAlive(pid)) return false;
		} catch {
			// stale/corrupt lock, take over
		}
	}
	mkdirSync(getDbPath(cwd), { recursive: true });
	writeFileSync(lockPath, `${process.pid}\n`);
	return true;
}

function releaseWriteLock(cwd: string): void {
	const lockPath = writeLockPath(cwd);
	try {
		// Only remove the lock if we still own it.
		const pid = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
		if (pid === process.pid) unlinkSync(lockPath);
	} catch {}
}

/**
 * Run `fn` while holding the project's write mutex, so concurrent indexers
 * (a watcher plus an ad-hoc `lmgrep index`) can't write at the same time and
 * produce duplicate chunk rows. Waits up to `waitMs` for a busy lock, taking
 * over a lock held by a dead process. Throws if the lock can't be acquired in
 * time.
 */
export async function withWriteLock<T>(
	cwd: string,
	fn: () => Promise<T>,
	opts: { waitMs?: number; pollMs?: number } = {},
): Promise<T> {
	const waitMs = opts.waitMs ?? 120_000;
	const pollMs = opts.pollMs ?? 200;
	let waited = 0;
	while (!tryAcquireWriteLock(cwd)) {
		if (waited >= waitMs) {
			throw new Error(
				"Could not acquire the index write lock — another indexer is busy. " +
					"Try again once it finishes.",
			);
		}
		await new Promise((r) => setTimeout(r, pollMs));
		waited += pollMs;
	}
	try {
		return await fn();
	} finally {
		releaseWriteLock(cwd);
	}
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
	private vocabTable: Table | undefined;

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
			const t = await conn.openTable(CHUNKS_TABLE);
			await migrateFileHashColumn(t);
			this.chunksTable = t;
			return this.chunksTable;
		}
		return undefined;
	}

	private async openFiles(): Promise<Table | undefined> {
		if (this.filesTable) return this.filesTable;
		const conn = await this.connection();
		const tables = await conn.tableNames();
		if (tables.includes(FILES_TABLE)) {
			const t = await conn.openTable(FILES_TABLE);
			await migrateBranchColumn(t, this.branch);
			this.filesTable = t;
			return this.filesTable;
		}
		return undefined;
	}

	// --- Vocab ---

	private async openVocab(): Promise<Table | undefined> {
		if (this.vocabTable) return this.vocabTable;
		const conn = await this.connection();
		const tables = await conn.tableNames();
		if (tables.includes(VOCAB_TABLE)) {
			this.vocabTable = await conn.openTable(VOCAB_TABLE);
			return this.vocabTable;
		}
		return undefined;
	}

	async hasVocab(): Promise<boolean> {
		return (await this.openVocab()) !== undefined;
	}

	/**
	 * Return the set of vocab terms already embedded in the vocab table.
	 * Used at index time to skip re-embedding.
	 */
	async getVocabTerms(): Promise<Set<string>> {
		const t = await this.openVocab();
		if (!t) return new Set();
		const rows = await t.query().select(["term"]).toArray();
		return new Set(rows.map((r) => r.term as string));
	}

	async addVocab(
		entries: Array<{ term: string; vector: number[] }>,
	): Promise<void> {
		if (entries.length === 0) return;

		// Dedup within the batch
		const seen = new Set<string>();
		const batchUnique: Array<{ term: string; vector: number[] }> = [];
		for (const e of entries) {
			if (seen.has(e.term)) continue;
			seen.add(e.term);
			batchUnique.push(e);
		}

		// Skip terms already in the table
		const known = await this.getVocabTerms();
		const records = batchUnique
			.filter((e) => !known.has(e.term))
			.map((e) => ({ term: e.term, vector: e.vector }));
		if (records.length === 0) return;

		const conn = await this.connection();
		const tables = await conn.tableNames();
		if (tables.includes(VOCAB_TABLE)) {
			const t = await conn.openTable(VOCAB_TABLE);
			this.vocabTable = t;
			await t.add(records);
		} else {
			this.vocabTable = await conn.createTable(VOCAB_TABLE, records);
		}
	}

	/**
	 * ANN search against the vocab table. Returns top-N terms closest to the
	 * given vector by cosine distance.
	 */
	async searchVocab(
		vector: number[],
		limit: number,
		excludeTerms?: Set<string>,
	): Promise<Array<{ term: string; score: number }>> {
		const t = await this.openVocab();
		if (!t) return [];
		const fetch = excludeTerms ? limit + excludeTerms.size : limit;
		const rows = await t.search(vector).limit(fetch).toArray();
		const out: Array<{ term: string; score: number }> = [];
		for (const r of rows) {
			const term = r.term as string;
			if (excludeTerms?.has(term)) continue;
			out.push({
				term,
				score: r._distance != null ? 1 - (r._distance as number) : 0,
			});
			if (out.length >= limit) break;
		}
		return out;
	}

	async vocabCount(): Promise<number> {
		const t = await this.openVocab();
		if (!t) return 0;
		return t.countRows();
	}

	async dropVocab(): Promise<void> {
		const conn = await this.connection();
		const tables = await conn.tableNames();
		if (tables.includes(VOCAB_TABLE)) {
			await conn.dropTable(VOCAB_TABLE);
		}
		this.vocabTable = undefined;
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
			fileHash: c.fileHash ?? "",
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

	private branchVersionsCache: Map<string, string> | undefined;

	/**
	 * Map of filePath -> file-version hash for the current branch (cached).
	 * Used to scope search to the exact file versions this branch references,
	 * so stale chunks from another version of the same path are excluded.
	 */
	async getBranchFileVersions(): Promise<Map<string, string> | undefined> {
		if (this.branchVersionsCache) return this.branchVersionsCache;
		const t = await this.openFiles();
		if (!t) return undefined;
		const escaped = this.branch.replace(/'/g, "''");
		const rows = await t
			.query()
			.where(`branch = '${escaped}'`)
			.select(["filePath", "fileHash"])
			.toArray();
		const map = new Map<string, string>();
		for (const r of rows) {
			map.set(r.filePath as string, r.fileHash as string);
		}
		this.branchVersionsCache = map;
		return this.branchVersionsCache;
	}

	/** Invalidate the branch files cache (call after index/import). */
	invalidateBranchFilesCache(): void {
		this.branchVersionsCache = undefined;
	}

	async search(
		queryVector: number[],
		limit = 25,
		filePrefix?: string,
		typeFilter?: string[],
		/** Pass false to skip branch scoping (e.g. for cross-project search). */
		scopeToBranch = true,
	): Promise<SearchResult[]> {
		const t = await this.openChunks();
		if (!t) {
			throw new Error("No index found. Run `lmgrep index` first.");
		}

		const branchVersions = scopeToBranch
			? await this.getBranchFileVersions()
			: undefined;

		// Over-fetch: branch/version filtering and dedup both discard rows, so
		// pull extra to still return `limit` distinct results.
		const fetchLimit = branchVersions ? limit * 3 : limit * 2;
		let query = t.search(queryVector).limit(fetchLimit);

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

		let mapped = results.map((r) => ({
			id: r.id as string,
			filePath: r.filePath as string,
			startLine: r.startLine as number,
			endLine: r.endLine as number,
			type: r.type as string,
			name: r.name as string,
			content: r.content as string,
			context: r.context as string,
			score: r._distance != null ? 1 - (r._distance as number) : 0,
			fileHash: (r.fileHash as string) ?? "",
		}));

		if (branchVersions) {
			mapped = mapped.filter((r) => {
				const want = branchVersions.get(r.filePath);
				// "" fileHash = legacy chunk, treated as wildcard.
				return want !== undefined && (r.fileHash === "" || r.fileHash === want);
			});
		}

		return dedupeRows(mapped)
			.slice(0, limit)
			.map(({ id, fileHash, ...rest }) => rest);
	}

	/**
	 * Same as search() but also returns each chunk's vector — needed for
	 * client-side clustering (facet command).
	 */
	async searchWithVectors(
		queryVector: number[],
		limit = 25,
		filePrefix?: string,
		scopeToBranch = true,
	): Promise<Array<SearchResult & { id: string; vector: number[] }>> {
		const t = await this.openChunks();
		if (!t) {
			throw new Error("No index found. Run `lmgrep index` first.");
		}
		const branchVersions = scopeToBranch
			? await this.getBranchFileVersions()
			: undefined;
		const fetchLimit = branchVersions ? limit * 3 : limit * 2;
		let query = t.search(queryVector).limit(fetchLimit);
		if (filePrefix) {
			query = query.where(
				`filePath LIKE '${filePrefix.replace(/'/g, "''")}%'`,
			);
		}
		const results = await query.toArray();

		let mapped = results.map((r) => ({
			id: r.id as string,
			filePath: r.filePath as string,
			startLine: r.startLine as number,
			endLine: r.endLine as number,
			type: r.type as string,
			name: r.name as string,
			content: r.content as string,
			context: r.context as string,
			score: r._distance != null ? 1 - (r._distance as number) : 0,
			fileHash: (r.fileHash as string) ?? "",
			vector: Array.from(r.vector as Iterable<number>),
		}));

		if (branchVersions) {
			mapped = mapped.filter((r) => {
				const want = branchVersions.get(r.filePath);
				return want !== undefined && (r.fileHash === "" || r.fileHash === want);
			});
		}
		return dedupeRows(mapped)
			.slice(0, limit)
			.map(({ fileHash, ...rest }) => rest);
	}

	/**
	 * Fetch chunks (with vectors) by id. Used to rehydrate faceting sessions.
	 * Missing ids are silently dropped.
	 */
	async getChunksByIds(
		ids: string[],
	): Promise<Array<SearchResult & { id: string; vector: number[] }>> {
		if (ids.length === 0) return [];
		const t = await this.openChunks();
		if (!t) return [];
		const escaped = ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(",");
		const rows = await t.query().where(`id IN (${escaped})`).toArray();
		return rows.map((r) => ({
			id: r.id as string,
			filePath: r.filePath as string,
			startLine: r.startLine as number,
			endLine: r.endLine as number,
			type: r.type as string,
			name: r.name as string,
			content: r.content as string,
			context: r.context as string,
			score: 0,
			vector: Array.from(r.vector as Iterable<number>),
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

	/**
	 * Stream chunk texts (name + content only) in batches. Used by vocab
	 * backfill to avoid loading all chunks into memory at once.
	 */
	async *streamChunkTexts(
		batchSize = 1000,
	): AsyncIterable<Array<{ name: string; content: string }>> {
		const t = await this.openChunks();
		if (!t) return;
		const stream = await t
			.query()
			.select(["name", "content"])
			.toArray();
		for (let i = 0; i < stream.length; i += batchSize) {
			yield stream.slice(i, i + batchSize).map((r) => ({
				name: (r.name as string) ?? "",
				content: (r.content as string) ?? "",
			}));
		}
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
		entries: Array<{ filePath: string; fileHash: string; branch?: string }>,
	): Promise<void> {
		if (entries.length === 0) return;

		const records = entries.map((e) => ({
			filePath: e.filePath,
			fileHash: e.fileHash,
			branch: e.branch ?? this.branch,
		}));

		const conn = await this.connection();
		const tables = await conn.tableNames();

		if (tables.includes(FILES_TABLE)) {
			const t = await conn.openTable(FILES_TABLE);
			this.filesTable = t;
			// Delete existing entries for the same branch + filePath pairs.
			// Group by branch so we don't accidentally clobber other branches'
			// rows for the same path.
			const byBranch = new Map<string, string[]>();
			for (const r of records) {
				const list = byBranch.get(r.branch) ?? [];
				list.push(r.filePath);
				byBranch.set(r.branch, list);
			}
			for (const [branch, paths] of byBranch) {
				const escaped = branch.replace(/'/g, "''");
				for (let i = 0; i < paths.length; i += DELETE_BATCH_SIZE) {
					const batch = paths.slice(i, i + DELETE_BATCH_SIZE);
					const pathFilter = buildInFilter("filePath", batch);
					await t.delete(`branch = '${escaped}' AND ${pathFilter}`);
				}
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
				fileHash: (r.fileHash as string) ?? "",
				vector: Array.from(r.vector as Iterable<number>),
			}));
		}
	}

	/**
	 * Remove redundant rows from the chunks table:
	 *  - exact duplicate ids (identical rows from concurrent unlocked indexing)
	 *  - orphaned versions: chunks whose fileHash is no longer referenced by any
	 *    branch's manifest (left behind when a file was edited on one branch
	 *    while another branch still pointed at the old path). Legacy chunks with
	 *    an empty fileHash are kept.
	 * Rewrites the table from the surviving rows. Loads chunks into memory in
	 * batches, so this is a maintenance operation, not a hot path.
	 */
	async dedupeChunks(): Promise<{
		before: number;
		after: number;
		duplicateIds: number;
		staleVersions: number;
	}> {
		const t = await this.openChunks();
		if (!t) return { before: 0, after: 0, duplicateIds: 0, staleVersions: 0 };
		const before = await t.countRows();

		// Which (filePath, fileHash) pairs any branch still references.
		const refs = new Map<string, Set<string>>();
		for (const e of await this.getAllFileEntries()) {
			const set = refs.get(e.filePath) ?? new Set<string>();
			set.add(e.fileHash);
			refs.set(e.filePath, set);
		}

		const kept: IndexedChunk[] = [];
		const seenIds = new Set<string>();
		let duplicateIds = 0;
		let staleVersions = 0;

		for await (const batch of this.streamAllChunks(2000)) {
			for (const r of batch) {
				const id = r.id as string;
				if (seenIds.has(id)) {
					duplicateIds++;
					continue;
				}
				seenIds.add(id);

				const filePath = r.filePath as string;
				const fileHash = (r.fileHash as string) ?? "";
				if (fileHash !== "" && !refs.get(filePath)?.has(fileHash)) {
					staleVersions++;
					continue;
				}

				kept.push({
					id,
					filePath,
					startLine: r.startLine as number,
					endLine: r.endLine as number,
					type: r.type as string,
					name: r.name as string,
					content: r.content as string,
					context: r.context as string,
					hash: r.hash as string,
					fileHash,
					vector: r.vector as number[],
				});
			}
		}

		if (duplicateIds + staleVersions === 0) {
			return { before, after: before, duplicateIds, staleVersions };
		}

		// Rewrite the table from the survivors.
		const conn = await this.connection();
		if ((await conn.tableNames()).includes(CHUNKS_TABLE)) {
			await conn.dropTable(CHUNKS_TABLE);
		}
		this.chunksTable = undefined;
		if (kept.length > 0) await this.addChunks(kept);

		return { before, after: kept.length, duplicateIds, staleVersions };
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
		if (tables.includes(VOCAB_TABLE)) await conn.dropTable(VOCAB_TABLE);
		this.chunksTable = undefined;
		this.filesTable = undefined;
		this.vocabTable = undefined;
	}

	async compact(): Promise<void> {
		const t = await this.openChunks();
		if (t) await t.optimize();
		const f = await this.openFiles();
		if (f) await f.optimize();
		const v = await this.openVocab();
		if (v) await v.optimize();
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
					fileHash: (r.fileHash as string) ?? "",
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

	/**
	 * Return all distinct branch names present in the files table.
	 */
	async getStoredBranches(): Promise<string[]> {
		const t = await this.openFiles();
		if (!t) return [];
		const rows = await t.query().select(["branch"]).toArray();
		return [...new Set(rows.map((r) => r.branch as string))];
	}

	/**
	 * Delete all file manifest rows for a given branch.
	 */
	async deleteBranchManifest(branch: string): Promise<void> {
		const t = await this.openFiles();
		if (!t) return;
		const escaped = branch.replace(/'/g, "''");
		await t.delete(`branch = '${escaped}'`);
	}

	/**
	 * Copy another branch's file manifest to this store's branch.
	 * Used to bootstrap a new branch from a merge base.
	 */
	async copyBranchManifest(sourceBranch: string): Promise<number> {
		const t = await this.openFiles();
		if (!t) return 0;
		const escaped = sourceBranch.replace(/'/g, "''");
		const rows = await t
			.query()
			.where(`branch = '${escaped}'`)
			.select(["filePath", "fileHash"])
			.toArray();
		if (rows.length === 0) return 0;

		const records = rows.map((r) => ({
			filePath: r.filePath as string,
			fileHash: r.fileHash as string,
			branch: this.branch,
		}));

		await t.add(records);
		return records.length;
	}

	async close(): Promise<void> {
		this.chunksTable = undefined;
		this.filesTable = undefined;
		this.vocabTable = undefined;
		this.db = undefined;
	}
}
