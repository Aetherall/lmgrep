import type { ContentHash } from "../corpus/ContentHash.js";
import type { FileManifest, SourceFile } from "../corpus/SourceFile.js";
import type { Branch } from "../project/Branch.js";

/** One manifest row: a file version recorded on a branch. */
export interface ManifestEntry {
	filePath: string;
	fileHash: ContentHash;
	branch: Branch;
}

/**
 * The branch-scoped record of which file versions are indexed.
 *
 * Chunks are shared across branches by content; this is what decides which of
 * them a branch can see.
 */
export interface FileManifestRepositoryPort {
	/** Manifest for the repository's own branch. */
	current(): Promise<FileManifest>;
	/** Cached manifest used for scoping searches; see {@link invalidate}. */
	branchVersions(): Promise<FileManifest | undefined>;
	/** Drop the cached manifest after an index or import. */
	invalidate(): void;
	upsert(entries: SourceFile[]): Promise<void>;
	deleteFiles(filePaths: string[]): Promise<void>;
	/** Of the given file hashes, those any branch has already indexed. */
	knownHashes(hashes: ContentHash[]): Promise<Set<string>>;
	allEntries(): Promise<ManifestEntry[]>;
	storedBranches(): Promise<string[]>;
	deleteBranch(branch: string): Promise<void>;
	/** Copy another branch's manifest onto ours; returns rows copied. */
	copyFromBranch(sourceBranch: string): Promise<number>;
}
