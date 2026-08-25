/**
 * Access to the directory where lmgrep keeps its databases and sessions.
 *
 * Narrow by design: the domain needs to know where state lives and whether a
 * given database exists, not how to read or write files.
 */
export interface StateDirectoryPort {
	/** Absolute path of the state root (e.g. ~/.local/state/lmgrep). */
	root(): string;
	/** Whether `path` exists and is a directory. */
	isDirectory(path: string): boolean;
	/** Absolute paths of the immediate child directories of the state root. */
	listDatabaseDirectories(): string[];
}
