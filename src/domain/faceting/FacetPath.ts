/**
 * A location in a facet tree: a session id followed by the cluster labels
 * walked to get there, e.g. `kx3/token/access`.
 *
 * Labels are the path segments because they are what the user actually saw and
 * typed back; that makes the path human-writable rather than an opaque handle.
 */
export class FacetPath {
	private constructor(
		readonly sessionId: string,
		readonly segments: readonly string[],
	) {}

	/** Parse user input, or undefined when it is malformed. */
	static parse(input: string): FacetPath | undefined {
		const parts = input.split("/").filter(Boolean);
		if (parts.length === 0) return undefined;
		const id = parts[0];
		if (!/^[a-z2-9]+$/.test(id)) return undefined;
		return new FacetPath(id, parts.slice(1));
	}

	static root(sessionId: string): FacetPath {
		return new FacetPath(sessionId, []);
	}

	/** Key identifying the node within its session — "" for the root. */
	get nodeKey(): string {
		return this.segments.join("/");
	}

	get isRoot(): boolean {
		return this.segments.length === 0;
	}

	child(label: string): FacetPath {
		return new FacetPath(this.sessionId, [...this.segments, label]);
	}

	/** Labels of every ancestor, used to stop a refinement reusing them. */
	ancestorLabels(): Set<string> {
		return new Set(this.segments);
	}

	toString(): string {
		return [this.sessionId, ...this.segments].join("/");
	}
}
