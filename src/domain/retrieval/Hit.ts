import type { CodeLocation } from "../corpus/CodeLocation.js";
import type { FileVersion } from "../corpus/FileVersion.js";

/** A retrieved chunk together with its similarity score. */
export class Hit {
	constructor(
		/** Chunk identity, kept for deduplication and facet session pooling. */
		readonly id: string,
		readonly location: CodeLocation,
		readonly type: string,
		readonly name: string,
		readonly content: string,
		readonly context: string,
		readonly score: number,
		readonly fileVersion: FileVersion,
	) {}

	/** The same hit with its path rooted under another project's directory. */
	relocatedUnder(root: string): Hit {
		return new Hit(
			this.id,
			this.location.relocatedUnder(root),
			this.type,
			this.name,
			this.content,
			this.context,
			this.score,
			this.fileVersion,
		);
	}
}
