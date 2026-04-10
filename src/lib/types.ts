export interface LmgrepConfig {
	/** Model in "provider:model" format, e.g. "openai:text-embedding-3-small" */
	model: string;
	/** Override the provider package (defaults to "@ai-sdk/<provider>") */
	provider?: string;
	/** Base URL for OpenAI-compatible providers */
	baseURL?: string;
	/**
	 * Provider runs locally with no per-request cost (e.g. ollama, lmstudio).
	 * When true, background health checks may call the embedding endpoint freely;
	 * when false, checks are run sparingly to avoid billed API calls.
	 */
	local?: boolean;
	/** Number of texts to embed per API call */
	batchSize: number;
	/** Embedding dimensions (if the model supports configurable dimensions) */
	dimensions?: number;
	/** Prefix prepended to queries at search time (e.g. "search_query: ") */
	queryPrefix?: string;
	/** Prefix prepended to documents at index time (e.g. "search_document: ") */
	documentPrefix?: string;
	/** Max tokens per chunk — chunks exceeding this are skipped (estimated at 4 chars/token) */
	maxTokens?: number;
	/** Additional ignore patterns (merged with .gitignore and defaults) */
	ignore?: string[];
	/** File extension overrides */
	extensions?: {
		/** Additional extensions to include (e.g. [".sql", ".graphql"]) */
		include?: string[];
		/** Extensions to exclude from the default set (e.g. [".json"]) */
		exclude?: string[];
	};
}

export interface Chunk {
	id: string;
	filePath: string;
	startLine: number;
	endLine: number;
	type: string;
	name: string;
	content: string;
	context: string;
	hash: string;
}

export interface IndexedChunk extends Chunk {
	vector: number[];
}

export interface SearchResult {
	filePath: string;
	startLine: number;
	endLine: number;
	type: string;
	name: string;
	content: string;
	context: string;
	score: number;
}

export interface SearchOptions {
	limit?: number;
	filePrefix?: string;
	not?: string;
	minScore?: number;
	/** Only return chunks of these AST types (e.g. "function_declaration") */
	type?: string[];
	/** Only return chunks from files of these languages (by extension, e.g. ".ts", ".py") */
	language?: string[];
	/** Search a different project's index instead of the current one */
	project?: string;
	/** Search multiple project indexes and merge results by score */
	across?: string[];
}

export interface BuildOptions {
	reset?: boolean;
	since?: string;
	force?: boolean;
	dry?: boolean;
	verbose?: boolean;
	/** Only process these specific files instead of scanning the full tree */
	files?: string[];
	onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
	phase: "scan" | "chunk" | "embed" | "store";
	current: number;
	total: number;
	message?: string;
}

export interface RepairResult {
	orphaned: string[];
	stale: string[];
	chunkMismatch: string[];
	chunksRemoved: number;
}

export interface StatusInfo {
	projectRoot: string;
	prefix: string;
	config: LmgrepConfig;
	fileCount: number;
	chunkCount: number;
	uniqueHashes: number;
	embeddingOk: boolean;
	embeddingLatencyMs?: number;
	/** Smoke search check: did a generic query return ≥1 result? */
	searchOk: boolean;
	searchResultCount?: number;
	searchLatencyMs?: number;
	/** Model string from the index metadata (what built the baseline) */
	indexModel?: string;
	/** Embedding dimensions from the index metadata */
	indexDimensions?: number;
}

export interface Logger {
	info(msg: string): void;
	error(msg: string): void;
}

export const consoleLogger: Logger = {
	info(msg: string) {
		console.log(`[${new Date().toISOString()}] ${msg}`);
	},
	error(msg: string) {
		console.error(`[${new Date().toISOString()}] ${msg}`);
	},
};

export const silentLogger: Logger = {
	info() {},
	error() {},
};

export interface Chunker {
	chunk(filePath: string, cwd: string): Promise<Chunk[]>;
}

export interface FileChange {
	path: string;
	kind: "added" | "modified" | "deleted";
}

export interface FileEntry {
	path: string;
	hash: string;
}
