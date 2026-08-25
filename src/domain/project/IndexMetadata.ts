/**
 * What an index records about itself: where it came from and how it was built.
 *
 * The model and dimensions are the important part — they are what lets a later
 * search detect that it is querying with incompatible embeddings instead of
 * silently returning nonsense.
 */
export interface IndexMetadata {
	root: string;
	remote?: string;
	branch: string;
	indexedAt: string;
	/** Full model string used at index time (e.g. "openai:nomic-embed-text"). */
	model?: string;
	/** Embedding vector dimensions. */
	dimensions?: number;
}

/** An index directory paired with the metadata found inside it. */
export interface DiscoveredIndex {
	databasePath: string;
	metadata: IndexMetadata;
}
