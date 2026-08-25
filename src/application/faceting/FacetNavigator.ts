import { FacetPath } from "../../domain/faceting/FacetPath.js";
import type {
	FacetChild,
	FacetSession,
} from "../../domain/faceting/FacetSession.js";
import type {
	ChunkRepositoryPort,
	VectorHit,
} from "../../domain/ports/ChunkRepositoryPort.js";
import type { EmbedderPort } from "../../domain/ports/EmbedderPort.js";
import type { VocabRepositoryPort } from "../../domain/ports/VocabRepositoryPort.js";
import type { ProjectId } from "../../domain/project/ProjectId.js";
import type { Hit } from "../../domain/retrieval/Hit.js";
import type { FacetSessionStore } from "../../infrastructure/fs/FacetSessionStore.js";
import type { FacetCluster, FacetEngine } from "./FacetEngine.js";

export interface FacetOptions {
	limit?: number;
	/** How many clusters to produce. */
	k?: number;
	filePrefix?: string;
}

/** A one-shot facet view, with no session behind it. */
export interface FacetOverview {
	query: string;
	clusters: FacetCluster[];
}

/** A facet view addressable by path, so it can be drilled into later. */
export interface FacetView {
	sessionId: string;
	path: string;
	query: string;
	labels: string[];
	candidates: string[][];
	qualifiers: string[][];
	disambiguators: Array<Array<{ vs: string; terms: string[] }>>;
}

/** The results pooled at one node of the tree. */
export interface FacetContents {
	sessionId: string;
	path: string;
	query: string;
	results: Hit[];
}

/**
 * Drives faceted exploration: compute clusters, remember them, and let the
 * user walk into one.
 *
 * Sessions exist because each step must reuse the exact pool the previous step
 * produced. Re-running retrieval on drill-down would silently change the pool
 * under the user, so a refinement clusters the stored hit ids instead.
 */
export class FacetNavigator {
	private static readonly DEFAULT_LIMIT = 25;
	private static readonly DEFAULT_K = 5;

	constructor(
		private readonly embedder: EmbedderPort,
		private readonly chunks: ChunkRepositoryPort,
		private readonly vocab: VocabRepositoryPort,
		private readonly engine: FacetEngine,
		private readonly sessions: FacetSessionStore,
		private readonly projectId: () => ProjectId,
	) {}

	/** Cluster a query's results without recording a session. */
	async overview(
		query: string,
		options: FacetOptions = {},
	): Promise<FacetOverview> {
		const hits = await this.retrieve(query, options);
		return {
			query,
			clusters: await this.engine.cluster(
				hits,
				query,
				options.k ?? FacetNavigator.DEFAULT_K,
			),
		};
	}

	/** Cluster a query's results and open a session over them. */
	async startSession(
		query: string,
		options: FacetOptions = {},
	): Promise<FacetView> {
		const hits = await this.retrieve(query, options);
		const session = this.sessions.create(
			this.projectId(),
			query,
			hits.map((h) => h.hit.id),
		);
		const clusters = await this.engine.cluster(
			hits,
			query,
			options.k ?? FacetNavigator.DEFAULT_K,
		);

		const path = FacetPath.root(session.id);
		session.attachChildren(path, this.toChildren(clusters));
		this.sessions.save(this.projectId(), session);

		return this.toView(session, path, clusters);
	}

	/** Read back the clusters already computed at a path. */
	async list(input: string): Promise<FacetView> {
		const { session, node } = this.locate(input);
		if (!node.children) {
			throw new Error(
				`No facets computed at ${input}. Run \`lmgrep facet refine ${input}\`.`,
			);
		}
		return {
			sessionId: session.id,
			path: input,
			query: session.query,
			labels: node.children.map((c) => c.label),
			candidates: node.children.map((c) => c.candidates ?? [c.label]),
			qualifiers: node.children.map((c) => c.qualifiers ?? []),
			disambiguators: node.children.map((c) => c.disambiguators ?? []),
		};
	}

	/** The results pooled at a path, in their original retrieval order. */
	async show(input: string): Promise<FacetContents> {
		const { session, node } = this.locate(input);
		const fetched = await this.chunks.findByIds(node.hits);

		// findByIds returns storage order; the node's order is retrieval rank,
		// which is the ranking the user was shown.
		const byId = new Map(fetched.map((v) => [v.hit.id, v.hit]));
		const ordered = node.hits
			.map((id) => byId.get(id))
			.filter((h): h is Hit => h !== undefined);

		return {
			sessionId: session.id,
			path: input,
			query: session.query,
			results: ordered,
		};
	}

	/** Sub-divide the pool at a path into its own clusters. */
	async refine(input: string, options: FacetOptions = {}): Promise<FacetView> {
		const { session, path, node } = this.locate(input);
		const hits = await this.chunks.findByIds(node.hits);
		if (hits.length === 0) {
			return {
				sessionId: session.id,
				path: input,
				query: session.query,
				labels: [],
				candidates: [],
				qualifiers: [],
				disambiguators: [],
			};
		}

		const clusters = await this.engine.cluster(
			hits,
			session.query,
			options.k ?? FacetNavigator.DEFAULT_K,
			// Ancestor labels are excluded so a refinement cannot re-use the
			// word the user just drilled into.
			path.ancestorLabels(),
		);

		session.attachChildren(path, this.toChildren(clusters));
		this.sessions.save(this.projectId(), session);
		return this.toView(session, path, clusters, input);
	}

	private async retrieve(
		query: string,
		options: FacetOptions,
	): Promise<VectorHit[]> {
		if (!(await this.vocab.exists())) {
			throw new Error(
				"No vocab table found. Re-run `lmgrep index` to build it.",
			);
		}
		const vector = await this.embedder.embedQuery(query);
		return this.chunks.searchWithVectors({
			vector,
			limit: options.limit ?? FacetNavigator.DEFAULT_LIMIT,
			filePrefix: options.filePrefix,
			scopeToBranch: true,
		});
	}

	private locate(input: string) {
		const path = FacetPath.parse(input);
		if (!path) throw new Error(`Invalid facet path: ${input}`);

		const session = this.sessions.load(this.projectId(), path.sessionId);
		if (!session) {
			throw new Error(
				`Unknown facet session: ${path.sessionId}. ` +
					"Run `lmgrep facet search <query>` first.",
			);
		}

		const node = session.nodeAt(path);
		if (!node) {
			throw new Error(`Path not found in session: ${input}`);
		}
		return { session, path, node };
	}

	private toChildren(clusters: FacetCluster[]): FacetChild[] {
		return clusters.map((c) => ({
			label: c.label,
			size: c.size,
			hits: c.hits.map((h) => h.id),
			candidates: c.candidates,
			qualifiers: c.qualifiers,
			disambiguators: c.disambiguators,
		}));
	}

	private toView(
		session: FacetSession,
		path: FacetPath,
		clusters: FacetCluster[],
		displayPath?: string,
	): FacetView {
		return {
			sessionId: session.id,
			path: displayPath ?? path.toString(),
			query: session.query,
			labels: clusters.map((c) => c.label),
			candidates: clusters.map((c) => c.candidates),
			qualifiers: clusters.map((c) => c.qualifiers),
			disambiguators: clusters.map((c) => c.disambiguators),
		};
	}
}
