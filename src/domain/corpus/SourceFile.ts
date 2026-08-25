import type { ContentHash } from "./ContentHash.js";

/** A file on disk as the indexer sees it: a repo-relative path and its hash. */
export class SourceFile {
	constructor(
		readonly path: string,
		readonly hash: ContentHash,
	) {}
}

/**
 * The set of files a branch has indexed, as path → content hash.
 *
 * This is the branch-scoped part of the index. Chunks are shared across
 * branches by content, so the manifest is what decides which of them a given
 * branch can see.
 */
export class FileManifest {
	constructor(private readonly entries: ReadonlyMap<string, ContentHash>) {}

	static empty(): FileManifest {
		return new FileManifest(new Map());
	}

	static fromEntries(
		entries: Iterable<readonly [string, ContentHash]>,
	): FileManifest {
		return new FileManifest(new Map(entries));
	}

	get size(): number {
		return this.entries.size;
	}

	get isEmpty(): boolean {
		return this.entries.size === 0;
	}

	versionOf(path: string): ContentHash | undefined {
		return this.entries.get(path);
	}

	has(path: string): boolean {
		return this.entries.has(path);
	}

	paths(): Iterable<string> {
		return this.entries.keys();
	}

	[Symbol.iterator](): Iterator<[string, ContentHash]> {
		return this.entries[Symbol.iterator]();
	}
}
