/**
 * mulberry32 — a small deterministic PRNG.
 *
 * Clustering must be reproducible: the same hits must always yield the same
 * facet labels, or a refine on an unchanged pool would reshuffle under the
 * user. Seeded explicitly rather than using Math.random for that reason.
 */
export class SeededRandom {
	private state: number;

	constructor(seed: number) {
		this.state = seed >>> 0;
	}

	/** Next float in [0, 1). */
	next(): number {
		this.state = (this.state + 0x6d2b79f5) >>> 0;
		let t = this.state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	/** Uniform integer in [0, bound). */
	nextIndex(bound: number): number {
		return Math.floor(this.next() * bound);
	}
}
