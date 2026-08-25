import type { Vector } from "../faceting/Vector.js";

/** A vocabulary term with its similarity to a queried axis. */
export interface ScoredTerm {
	term: string;
	score: number;
}

/** A term and its embedding, ready to store. */
export interface EmbeddedTerm {
	term: string;
	vector: Vector;
}

/**
 * The vocabulary index: corpus terms embedded in the same space as chunks, so
 * a direction in that space can be named with a word the codebase actually uses.
 */
export interface VocabRepositoryPort {
	exists(): Promise<boolean>;
	/** Terms already embedded, so indexing can skip them. */
	storedTerms(): Promise<Set<string>>;
	add(terms: EmbeddedTerm[]): Promise<void>;
	/** Terms nearest to a direction, excluding any caller-supplied words. */
	nearest(
		axis: Vector,
		limit: number,
		exclude?: Set<string>,
	): Promise<ScoredTerm[]>;
	count(): Promise<number>;
	drop(): Promise<void>;
}
