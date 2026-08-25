/** One model's database for a project. */
export interface ProjectIndex {
	databasePath: string;
	/** Full model string it was built with, when the sidecar records one. */
	model?: string;
	dimensions?: number;
	indexedAt?: string;
	bytes: number;
}

/**
 * The databases a single project holds — one per embedding model.
 *
 * Read by direct observation rather than from bookkeeping: they are siblings
 * in one directory, and looking is both cheaper and more truthful than a
 * registry that can disagree with what is on disk.
 */
export interface ProjectIndexesPort {
	/** Every database under a project's index home, largest first. */
	list(indexHome: string): ProjectIndex[];
}
