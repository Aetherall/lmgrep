import type { Clustering } from "./Clustering.js";
import { Vector } from "./Vector.js";

/**
 * The directions in embedding space that distinguish clusters from each other.
 *
 * Two kinds, and the difference matters:
 *
 *  - The **contrast axis** of a cluster is its centroid minus the mean of all
 *    the others. That beats `centroid - globalMean`, which dilutes the axis by
 *    including the cluster's own mass and skews toward large clusters.
 *  - A **pairwise axis** is one centroid minus another, which names the
 *    specific boundary between two clusters rather than a collapsed average.
 */
export class ClusterAxes {
	private readonly centroids: Vector[];
	private readonly sums: Vector[];
	private readonly sizes: number[];
	private readonly total: Vector;
	private readonly itemCount: number;

	constructor(vectors: readonly Vector[], clustering: Clustering) {
		const groups = clustering.groups();
		this.sizes = groups.map((g) => g.length);
		this.sums = groups.map((g) => Vector.sum(g.map((i) => vectors[i])));
		this.centroids = groups.map((g) =>
			Vector.mean(g.map((i) => vectors[i])).normalized(),
		);
		this.total = Vector.sum(this.sums);
		this.itemCount = clustering.itemCount;
	}

	get count(): number {
		return this.centroids.length;
	}

	centroidOf(cluster: number): Vector {
		return this.centroids[cluster];
	}

	sizeOf(cluster: number): number {
		return this.sizes[cluster];
	}

	/**
	 * `centroid - mean(siblings)`. With no siblings the centroid itself is the
	 * only meaningful direction.
	 */
	contrastAxis(cluster: number): Vector {
		const siblingCount = this.itemCount - this.sizes[cluster];
		if (siblingCount <= 0) return this.centroids[cluster];

		const siblingMean = this.total
			.minus(this.sums[cluster])
			.scaledBy(1 / siblingCount);
		return this.centroids[cluster]
			.minus(siblingMean.normalized())
			.normalized();
	}

	/** `centroid(a) - centroid(b)`: what separates these two specifically. */
	pairwiseAxis(a: number, b: number): Vector {
		return this.centroids[a].minus(this.centroids[b]).normalized();
	}
}
