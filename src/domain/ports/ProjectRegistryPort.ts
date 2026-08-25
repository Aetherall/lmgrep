/** A database this machine knows about, and where to find it. */
export interface RegisteredIndex {
	/** Working tree the index describes. */
	root: string;
	/**
	 * Set for a standalone index, named with `--in <name>`.
	 *
	 * Its `root` is only where it happened to be built from, so it is not a
	 * project: cross-project search resolves a project *path* to a database,
	 * and following that path would land on a different index entirely.
	 */
	name?: string;
	/** Origin remote, when the project has one. */
	remote?: string;
	/** Absolute path of the database directory. */
	databasePath: string;
	/** Full model string the index was built with. */
	model?: string;
	dimensions?: number;
	/** When this entry was last written. */
	indexedAt: string;
}

/**
 * The list of indexes on this machine.
 *
 * Databases live inside the repositories they describe, which is what keeps
 * them from being orphaned — but it also means nothing can enumerate them
 * without walking the filesystem. This registry is that list: pointers only,
 * a few hundred bytes each, and never the source of truth. An entry naming a
 * database that no longer exists is a dangling pointer, not lost data, and is
 * detected by looking rather than by bookkeeping.
 */
export interface ProjectRegistryPort {
	/** Record (or refresh) the entry for a database. */
	record(entry: Omit<RegisteredIndex, "indexedAt">): void;
	/** Entries whose database still exists. */
	list(): RegisteredIndex[];
	/** Entries whose database is gone — safe to forget. */
	dangling(): RegisteredIndex[];
	/** Drop the entry for a database. */
	forget(databasePath: string): void;
}
