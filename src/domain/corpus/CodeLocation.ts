/** Where a piece of code lives: a repo-relative path and an inclusive line span. */
export class CodeLocation {
	constructor(
		readonly filePath: string,
		readonly startLine: number,
		readonly endLine: number,
	) {}

	/** "path/to/file.ts:12-40" — the form used in output and citations. */
	toString(): string {
		return `${this.filePath}:${this.startLine}-${this.endLine}`;
	}

	/**
	 * The same span rooted under another directory. Used when merging results
	 * from other projects, whose paths must be absolute to be meaningful here.
	 */
	relocatedUnder(root: string): CodeLocation {
		return new CodeLocation(
			`${root}/${this.filePath}`,
			this.startLine,
			this.endLine,
		);
	}

	/** Extension including the dot, or "" when the path has none. */
	get extension(): string {
		const dot = this.filePath.lastIndexOf(".");
		return dot === -1 ? "" : this.filePath.slice(dot);
	}

	/** Whether two spans overlap — the basis for deduplicating nested hits. */
	overlaps(other: CodeLocation): boolean {
		return (
			this.filePath === other.filePath &&
			this.startLine <= other.endLine &&
			other.startLine <= this.endLine
		);
	}
}
