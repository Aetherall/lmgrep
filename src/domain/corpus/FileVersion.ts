import type { ContentHash } from "./ContentHash.js";

/**
 * Which version of a source file a chunk was produced from.
 *
 * Search scopes results to the exact file versions the current branch
 * references, so a stale chunk from another version of the same path cannot
 * leak into results. Chunks written before this column existed carry no
 * version; they are treated as matching anything rather than being hidden,
 * which would silently empty older indexes.
 *
 * That wildcard rule used to be spelled out at every filtering site. It lives
 * here now so there is one answer to "does this chunk belong to this version".
 */
export class FileVersion {
	/** The empty marker persisted for pre-versioning rows. */
	private static readonly UNKNOWN_MARKER = "";

	private constructor(private readonly value: string) {}

	static of(hash: ContentHash): FileVersion {
		return new FileVersion(hash.toString());
	}

	/** The version of a chunk indexed before file versions were recorded. */
	static unknown(): FileVersion {
		return new FileVersion(FileVersion.UNKNOWN_MARKER);
	}

	static fromStored(value: string | undefined | null): FileVersion {
		return new FileVersion(value ?? FileVersion.UNKNOWN_MARKER);
	}

	get isUnknown(): boolean {
		return this.value === FileVersion.UNKNOWN_MARKER;
	}

	/** Value to persist — the empty marker for unknown versions. */
	toStored(): string {
		return this.value;
	}

	/**
	 * Whether a chunk of this version should be returned when the branch
	 * references `wanted`. An unknown version matches anything.
	 */
	matches(wanted: ContentHash | undefined): boolean {
		if (wanted === undefined) return false;
		return this.isUnknown || this.value === wanted.toString();
	}
}
