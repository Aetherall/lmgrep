/**
 * Access to the machine-global directory lmgrep keeps beside its databases.
 *
 * Since databases moved inside the repositories they describe, what remains
 * here is only what cannot live in a repository: coordination between
 * processes on this machine, the pointer registry that makes indexes
 * discoverable without scanning the filesystem, and databases for projects
 * that have no repository to live in.
 *
 * Narrow by design: the domain needs to know where state lives, not how to
 * read or write files.
 */
export interface StateDirectoryPort {
	/** Absolute path of the state root (e.g. ~/.local/state/lmgrep). */
	root(): string;
	/** Whether `path` exists and is a directory. */
	isDirectory(path: string): boolean;
	/** Where lock files live. Machine-global: they coordinate processes. */
	locksDirectory(): string;
	/** Where registry entries live — one small JSON pointer per database. */
	registryDirectory(): string;
	/** Where databases live for projects outside any git repository. */
	databasesDirectory(): string;
	/**
	 * Databases written by versions that kept everything under the state root.
	 * Present only so they can be listed, adopted, or removed.
	 */
	legacyDatabaseDirectories(): string[];
}
