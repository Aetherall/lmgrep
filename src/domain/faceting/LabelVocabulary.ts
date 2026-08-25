import { Lexicon } from "./Lexicon.js";

/**
 * Tracks which words a facet run has already spent.
 *
 * Labels are deduplicated by stem, not surface form, because the vocabulary
 * table happily offers "subscription", "subscriptions" and "subscribe" for
 * three sibling clusters — three labels that tell the user nothing apart.
 * Query and ancestor terms are excluded for the same reason: repeating the
 * word the user just typed is not a distinction.
 */
export class LabelVocabulary {
	/** Shown when no unused term is available for a cluster. */
	static readonly FALLBACK_LABEL = "other";

	private readonly usedStems: Set<string>;
	private readonly excludedTerms: Set<string>;

	constructor(
		private readonly lexicon: Lexicon,
		queryTerms: Iterable<string>,
		ancestorLabels: Iterable<string>,
	) {
		this.usedStems = new Set<string>();
		this.excludedTerms = new Set<string>();
		for (const t of queryTerms) {
			this.excludedTerms.add(t);
			this.usedStems.add(this.lexicon.stem(t));
		}
		for (const t of ancestorLabels) {
			this.excludedTerms.add(t);
			this.usedStems.add(this.lexicon.stem(t));
		}
	}

	/** Terms the vocabulary search should not return at all. */
	get excluded(): Set<string> {
		return this.excludedTerms;
	}

	/** Claim the first candidate whose stem is still free. */
	claimLabel(candidates: readonly string[]): {
		label: string;
		stem: string;
	} {
		for (const term of candidates) {
			const stem = this.lexicon.stem(term);
			if (this.usedStems.has(stem)) continue;
			this.usedStems.add(stem);
			return { label: term, stem };
		}
		return { label: LabelVocabulary.FALLBACK_LABEL, stem: "" };
	}

	/** Take up to `max` candidates, unique by stem, seeded with `taken`. */
	distinctTerms(
		candidates: readonly string[],
		max: number,
		taken: Iterable<string> = [],
	): string[] {
		const stems = new Set<string>();
		for (const s of taken) stems.add(s);

		const out: string[] = [];
		for (const term of candidates) {
			if (out.length >= max) break;
			const stem = this.lexicon.stem(term);
			if (stems.has(stem)) continue;
			out.push(term);
			stems.add(stem);
		}
		return out;
	}

	stemOf(term: string): string {
		return this.lexicon.stem(term);
	}
}
