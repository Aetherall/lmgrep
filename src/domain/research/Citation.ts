/** A source an answer can cite: a numbered code location. */
export interface Source {
	n: number;
	path: string;
	startLine: number;
	endLine: number;
}

/**
 * Reads `[n]` citation markers out of an answer.
 *
 * Both the single `[3]` and the grouped `[3, 5]` forms must parse — small
 * models reach for the grouped form when one claim has several sources, and a
 * marker we cannot read is a source silently missing from the answer's list,
 * which is exactly the grounding the answer exists to provide.
 */
export class CitationMarkers {
	private static readonly PATTERN = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

	/** Every cited id in first-appearance order, groups expanded; may repeat. */
	static idsIn(text: string): number[] {
		const out: number[] = [];
		for (const match of text.matchAll(CitationMarkers.PATTERN)) {
			for (const part of match[1].split(",")) out.push(Number(part.trim()));
		}
		return out;
	}

	static present(text: string): boolean {
		return CitationMarkers.idsIn(text).length > 0;
	}

	/**
	 * Resolve cited ids against the sources actually surfaced, in citation
	 * order. Hallucinated ids are dropped: the marker stays in the prose, but
	 * no invented source is listed under it.
	 */
	static resolve(answer: string, sources: readonly Source[]): Source[] {
		const byNumber = new Map(sources.map((s) => [s.n, s]));
		const seen = new Set<number>();
		const out: Source[] = [];
		for (const n of CitationMarkers.idsIn(answer)) {
			if (seen.has(n)) continue;
			seen.add(n);
			const source = byNumber.get(n);
			if (source) out.push(source);
		}
		return out;
	}
}
