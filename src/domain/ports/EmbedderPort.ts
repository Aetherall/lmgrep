import type { Vector } from "../faceting/Vector.js";

/**
 * Turns text into embeddings.
 *
 * Documents and queries are separate operations because several models want
 * different prefixes for each ("search_document: " vs "search_query: "), and
 * getting that wrong degrades retrieval silently.
 */
export interface EmbedderPort {
	/** Embed indexable documents, in provider-sized batches. */
	embedDocuments(texts: string[]): Promise<Vector[]>;
	/** Embed a single search query. */
	embedQuery(query: string): Promise<Vector>;
}
