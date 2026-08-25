import type { FacetPath } from "./FacetPath.js";

/** A cluster hanging off a node, as computed by a facet run. */
export interface FacetChild {
	label: string;
	size: number;
	hits: string[];
	/** Top vocab candidates for this cluster's axis, label first. */
	candidates?: string[];
	/** Deduped pairwise qualifiers, for compact display. */
	qualifiers?: string[];
	/** Top terms distinguishing this cluster from each sibling. */
	disambiguators?: Array<{ vs: string; terms: string[] }>;
}

/** One node of the facet tree: a pool of hits and, once refined, its children. */
export interface FacetNode {
	/** "/"-joined labels from the root; "" for the root itself. */
	path: string;
	/** Chunk ids in this pool, in retrieval order. */
	hits: string[];
	children?: FacetChild[];
}

/** Serialized shape persisted between CLI invocations. */
export interface FacetSessionState {
	id: string;
	query: string;
	createdAt: number;
	nodes: Record<string, FacetNode>;
}

/**
 * A navigable tree of facets over one query's results.
 *
 * Sessions exist because faceting is iterative: the user drills into a cluster,
 * then another, and each step must reuse the pool the previous step produced
 * rather than re-running retrieval and getting a different pool.
 */
export class FacetSession {
	private constructor(private readonly state: FacetSessionState) {}

	static create(id: string, query: string, rootHits: string[]): FacetSession {
		return new FacetSession({
			id,
			query,
			createdAt: Date.now(),
			nodes: { "": { path: "", hits: rootHits } },
		});
	}

	static fromState(state: FacetSessionState): FacetSession {
		return new FacetSession(state);
	}

	toState(): FacetSessionState {
		return this.state;
	}

	get id(): string {
		return this.state.id;
	}

	get query(): string {
		return this.state.query;
	}

	nodeAt(path: FacetPath): FacetNode | undefined {
		return this.state.nodes[path.nodeKey];
	}

	/**
	 * Attach computed clusters to the node at `path`, registering each child as
	 * its own node so it can be listed, shown, or refined later.
	 */
	attachChildren(path: FacetPath, children: FacetChild[]): void {
		const parent = this.state.nodes[path.nodeKey];
		if (!parent) return;

		for (const child of children) {
			const childKey = path.child(child.label).nodeKey;
			if (!this.state.nodes[childKey]) {
				this.state.nodes[childKey] = {
					path: childKey,
					hits: child.hits,
				};
			}
		}
		parent.children = children;
	}
}
