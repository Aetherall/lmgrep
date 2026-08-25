import { Clustering } from "./Clustering.js";
import { SeededRandom } from "./SeededRandom.js";
import { Vector } from "./Vector.js";

/**
 * Bisecting k-means over unit vectors under cosine distance.
 *
 * Repeatedly splits the largest cluster in two until `k` clusters exist. Chosen
 * over flat k-means because it yields a stable, size-ordered partition without
 * needing a good initial k — which matters when the caller just wants "about
 * five kinds of thing" out of a result page.
 *
 * Inputs must already be normalized; {@link Vector.cosineDistanceTo} assumes it.
 */
export class BisectingKMeans {
	private static readonly MAX_ITERATIONS = 50;

	/**
	 * `seed` is fixed by default so the same pool always produces the same
	 * partition — refining an unchanged facet must not reshuffle under the user.
	 */
	constructor(private readonly seed = 42) {}

	cluster(vectors: readonly Vector[], k: number): Clustering {
		const n = vectors.length;
		if (n <= k) return Clustering.singletons(n);

		const clusters: number[][] = [vectors.map((_, i) => i)];

		while (clusters.length < k) {
			const largest = this.indexOfLargest(clusters);
			if (largest < 0) break;

			const members = clusters[largest];
			const labels = this.kmeans(
				members.map((i) => vectors[i]),
				2,
			);

			const left: number[] = [];
			const right: number[] = [];
			for (let i = 0; i < members.length; i++) {
				if (labels[i] === 0) left.push(members[i]);
				else right.push(members[i]);
			}
			// A degenerate split means this cluster cannot be divided further;
			// splitting the next-largest would loop, so stop here.
			if (left.length === 0 || right.length === 0) break;

			clusters.splice(largest, 1);
			clusters.push(left, right);
		}

		return Clustering.fromGroups(clusters);
	}

	/** Index of the biggest splittable cluster, or -1 when all are singletons. */
	private indexOfLargest(clusters: readonly number[][]): number {
		let bestIdx = -1;
		let bestSize = 1;
		for (let i = 0; i < clusters.length; i++) {
			if (clusters[i].length > bestSize) {
				bestSize = clusters[i].length;
				bestIdx = i;
			}
		}
		return bestIdx;
	}

	/**
	 * Lloyd's algorithm with k-means++ seeding, returning a label per input.
	 *
	 * The RNG is constructed here rather than held on the instance so every
	 * bisection draws from an identically-seeded stream — hoisting it would make
	 * each split depend on how many splits preceded it.
	 */
	private kmeans(vectors: readonly Vector[], k: number): number[] {
		if (vectors.length <= k) return vectors.map((_, i) => i);

		const rng = new SeededRandom(this.seed);
		let centroids = this.seedCentroids(vectors, k, rng);
		const labels = new Array(vectors.length).fill(0);

		for (let iter = 0; iter < BisectingKMeans.MAX_ITERATIONS; iter++) {
			let changed = false;
			for (let i = 0; i < vectors.length; i++) {
				const best = this.nearestCentroid(vectors[i], centroids);
				if (labels[i] !== best) {
					changed = true;
					labels[i] = best;
				}
			}
			if (!changed) break;
			centroids = this.recomputeCentroids(vectors, labels, k, rng);
		}
		return labels;
	}

	/** k-means++: seed each centroid proportionally to its squared-ish distance. */
	private seedCentroids(
		vectors: readonly Vector[],
		k: number,
		rng: SeededRandom,
	): Vector[] {
		const centroids: Vector[] = [vectors[rng.nextIndex(vectors.length)]];
		const dists = new Array(vectors.length).fill(Infinity);

		for (let c = 1; c < k; c++) {
			for (let i = 0; i < vectors.length; i++) {
				const d = vectors[i].cosineDistanceTo(centroids[c - 1]);
				if (d < dists[i]) dists[i] = d;
			}
			let sum = 0;
			for (const d of dists) sum += d;
			// Every point already coincides with a centroid — pick at random.
			if (sum === 0) {
				centroids.push(vectors[rng.nextIndex(vectors.length)]);
				continue;
			}
			let r = rng.next() * sum;
			let picked = 0;
			for (let i = 0; i < vectors.length; i++) {
				r -= dists[i];
				if (r <= 0) {
					picked = i;
					break;
				}
			}
			centroids.push(vectors[picked]);
		}
		return centroids;
	}

	private nearestCentroid(vector: Vector, centroids: readonly Vector[]): number {
		let best = 0;
		let bestD = Infinity;
		for (let c = 0; c < centroids.length; c++) {
			const d = vector.cosineDistanceTo(centroids[c]);
			if (d < bestD) {
				bestD = d;
				best = c;
			}
		}
		return best;
	}

	private recomputeCentroids(
		vectors: readonly Vector[],
		labels: readonly number[],
		k: number,
		rng: SeededRandom,
	): Vector[] {
		const groups: Vector[][] = Array.from({ length: k }, () => []);
		for (let i = 0; i < vectors.length; i++) groups[labels[i]].push(vectors[i]);

		return groups.map((group) =>
			// An emptied cluster is reseeded rather than dropped, so k stays fixed.
			group.length === 0
				? vectors[rng.nextIndex(vectors.length)]
				: Vector.sum(group).normalized(),
		);
	}
}
