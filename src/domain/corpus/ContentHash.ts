import { createHash } from "node:crypto";

/**
 * A truncated SHA-256 of some content, used to tell whether a file or chunk
 * has changed. 16 hex characters is far more than enough to avoid collisions
 * within one repository, and keeps the index rows small.
 */
export class ContentHash {
	private static readonly LENGTH = 16;

	private constructor(private readonly value: string) {}

	static of(content: string | Uint8Array): ContentHash {
		return new ContentHash(
			createHash("sha256")
				.update(content)
				.digest("hex")
				.slice(0, ContentHash.LENGTH),
		);
	}

	/** Rehydrate a hash already persisted in the index. */
	static fromStored(value: string): ContentHash {
		return new ContentHash(value);
	}

	toString(): string {
		return this.value;
	}

	equals(other: ContentHash): boolean {
		return this.value === other.value;
	}
}
