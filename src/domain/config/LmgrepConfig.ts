/**
 * User-supplied settings. A plain data contract: it mirrors the YAML file
 * one-to-one, and behaviour that depends on it lives on the services that read
 * it rather than here.
 */
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
	/**
	 * Generative chat model for `lmgrep ask`, in "provider:model" format
	 * (e.g. "lmstudio:qwen/qwen3.5-9b"). Optional — when set, it enables the
	 * agentic research loop that searches, reads, and synthesizes a grounded
	 * answer instead of returning raw chunks.
	 */
	chatModel?: string;
	/** Override the chat provider package (defaults to `provider`, then `@ai-sdk/<provider>`). */
	chatProvider?: string;
	/** Base URL for the chat model (defaults to `baseURL` — reuses the embedding endpoint). */
	chatBaseURL?: string;
	/** Max agentic steps `ask` may take before it must synthesize (default 8). */
	chatMaxSteps?: number;
	/** Wall-clock timeout for a single `ask` model call, in ms (default 240000). */
	chatTimeoutMs?: number;
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
