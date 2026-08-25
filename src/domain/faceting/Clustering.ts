/**
 * The result of a clustering run: a partition of the input positions into
 * groups. Holds indices rather than vectors so callers can carry their own
 * parallel arrays (hits, metadata) without the clusterer knowing about them.
 */
export class Clustering {
	private constructor(
		private readonly members: readonly (readonly number[])[],
	) {}

	static fromGroups(groups: readonly (readonly number[])[]): Clustering {
		return new Clustering(groups.filter((g) => g.length > 0));
	}

	/** One singleton group per input, used when there is nothing to split. */
	static singletons(count: number): Clustering {
		return new Clustering(Array.from({ length: count }, (_, i) => [i]));
	}

	get size(): number {
		return this.members.length;
	}

	/** Member positions per cluster, in stable cluster order. */
	groups(): readonly (readonly number[])[] {
		return this.members;
	}

	/** Total number of clustered items. */
	get itemCount(): number {
		let n = 0;
		for (const g of this.members) n += g.length;
		return n;
	}
}
