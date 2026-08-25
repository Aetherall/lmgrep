import type { Hit } from "./Hit.js";

/**
 * An ordered result page, with the reductions that always follow retrieval.
 *
 * These used to be loose steps repeated at each call site; collecting them
 * here means "what search returns" has one definition, and the ordering of the
 * reductions (dedup before trim, always) cannot drift between callers.
 */
export class HitList {
	private constructor(private readonly hits: readonly Hit[]) {}

	static of(hits: readonly Hit[]): HitList {
		return new HitList(hits);
	}

	static empty(): HitList {
		return new HitList([]);
	}

	get length(): number {
		return this.hits.length;
	}

	get isEmpty(): boolean {
		return this.hits.length === 0;
	}

	toArray(): Hit[] {
		return [...this.hits];
	}

	[Symbol.iterator](): Iterator<Hit> {
		return this.hits[Symbol.iterator]();
	}

	/**
	 * Drop redundant rows, keeping the first (highest-scoring) of each group:
	 *
	 *  1. Exact duplicates by chunk id — identical rows produced by concurrent
	 *     unlocked indexing.
	 *  2. Overlapping line ranges within a file — the fallback chunker's
	 *     sliding-window overlap, plus any parent/child or near-duplicate span.
	 *     Tree-sitter chunks are node-bounded and never overlap, so this only
	 *     ever removes genuine near-duplicates.
	 */
	deduplicated(): HitList {
		const seenIds = new Set<string>();
		const keptRanges = new Map<string, Array<[number, number]>>();
		const out: Hit[] = [];

		for (const hit of this.hits) {
			if (seenIds.has(hit.id)) continue;
			seenIds.add(hit.id);

			const { filePath, startLine, endLine } = hit.location;
			const ranges = keptRanges.get(filePath);
			if (ranges) {
				const overlaps = ranges.some(
					([s, e]) => startLine <= e && s <= endLine,
				);
				if (overlaps) continue;
				ranges.push([startLine, endLine]);
			} else {
				keptRanges.set(filePath, [[startLine, endLine]]);
			}
			out.push(hit);
		}

		return new HitList(out);
	}

	takeAtMost(limit: number): HitList {
		return new HitList(this.hits.slice(0, limit));
	}

	filtered(predicate: (hit: Hit) => boolean): HitList {
		return new HitList(this.hits.filter(predicate));
	}

	mapped(transform: (hit: Hit) => Hit): HitList {
		return new HitList(this.hits.map(transform));
	}

	/** Highest score first — used when merging pages from several projects. */
	sortedByScoreDescending(): HitList {
		return new HitList([...this.hits].sort((a, b) => b.score - a.score));
	}

	concat(other: HitList): HitList {
		return new HitList([...this.hits, ...other.hits]);
	}
}
