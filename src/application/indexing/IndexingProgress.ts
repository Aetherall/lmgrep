/** A phase of an index run, for progress reporting. */
export type IndexingPhase = "scan" | "chunk" | "embed" | "store";

export interface IndexingProgressEvent {
	phase: IndexingPhase;
	current: number;
	total: number;
	message?: string;
}

export interface IndexBuildOptions {
	/** Drop every table and rebuild from scratch. */
	reset?: boolean;
	/** Only consider files modified within this duration (e.g. "10m", "2h"). */
	since?: string;
	/** Report what would be indexed without doing it. */
	dry?: boolean;
	verbose?: boolean;
	/** Only process these paths instead of scanning the tree. */
	files?: string[];
	/**
	 * Allow this run to train a vector index if none exists. Off by default:
	 * training reads every vector and peaks at several GB, which must not
	 * happen behind a background watcher.
	 */
	createIndex?: boolean;
	onProgress?: (event: IndexingProgressEvent) => void;
}

export interface IndexBuildResult {
	/** Chunks embedded and stored. */
	succeeded: number;
	/** Chunks that failed to embed. */
	failed: number;
	/** Files dropped because they no longer exist in the working tree. */
	removed: number;
}
