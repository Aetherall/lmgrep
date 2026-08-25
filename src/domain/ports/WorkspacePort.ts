import { ContentHash } from "../corpus/ContentHash.js";
import type { SourceFile } from "../corpus/SourceFile.js";

/** Extension include/exclude overrides layered on the built-in set. */
export interface ExtensionRules {
	include?: string[];
	exclude?: string[];
}

/** Stops a running watch. */
export interface WatchHandle {
	close(): void;
}

/** Files whose on-disk hash differs from what the manifest recorded. */
export interface ChangeSet {
	changed: SourceFile[];
	/** Hash of every readable file scanned, changed or not. */
	current: Map<string, ContentHash>;
}

/**
 * The working tree: which files exist, what they contain, and when they
 * change. The indexer talks to this rather than to `node:fs` directly.
 */
export interface WorkspacePort {
	/** Indexable files under `cwd`, honouring ignore rules and extensions. */
	listFiles(
		cwd: string,
		extraIgnore?: string[],
		extensions?: ExtensionRules,
	): string[];

	/** Content hash of one file, or undefined when it cannot be read. */
	hashOf(cwd: string, filePath: string): ContentHash | undefined;

	/** Keep only files modified at or after `cutoffMs`. */
	modifiedSince(files: string[], cwd: string, cutoffMs: number): string[];

	/**
	 * Compare on-disk hashes against a manifest, reporting what differs.
	 * `force` treats every readable file as changed.
	 */
	detectChanges(
		files: string[],
		manifest: { versionOf(path: string): ContentHash | undefined },
		cwd: string,
		force?: boolean,
	): ChangeSet;

	/** Watch for changes, debounced, reporting the paths that changed. */
	watch(
		cwd: string,
		extraIgnore: string[] | undefined,
		onChanges: (changedFiles: string[]) => void,
		debounceMs: number,
		extensions?: ExtensionRules,
	): WatchHandle;
}
