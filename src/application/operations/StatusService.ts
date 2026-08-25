import type { ConfigSource } from "../../domain/config/ConfigSource.js";
import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";
import type { Vector } from "../../domain/corpus/Vector.js";
import type { ChunkRepositoryPort } from "../../domain/ports/ChunkRepositoryPort.js";
import type { EmbedderPort } from "../../domain/ports/EmbedderPort.js";
import type {
	IndexMaintenancePort,
	VectorIndexState,
} from "../../domain/ports/IndexMaintenancePort.js";
import type { IndexMetadataPort } from "../../domain/ports/IndexMetadataPort.js";
import type { DatabaseLocation } from "../../domain/project/DatabaseLocation.js";
import type { ProjectLocator } from "../../domain/project/ProjectLocator.js";
import { Deadline } from "./Deadline.js";
import type { IndexAlternatives } from "./IndexAlternatives.js";

/**
 * Whether search works right now, and if not, the one thing to do about it.
 *
 * A single verdict rather than a wall of statistics: the question someone runs
 * `status` to answer is "is it working", and burying that under file counts
 * and latency figures made every reader derive it themselves.
 */
export type StatusVerdict =
	| { searchable: true; note?: string }
	| { searchable: false; reason: string; fix: string };

export interface StatusInfo {
	verdict: StatusVerdict;
	projectRoot: string;
	prefix: string;
	databasePath: string;
	config: LmgrepConfig;
	/** Which files supplied the configuration, in increasing precedence. */
	configSources: readonly ConfigSource[];
	fileCount: number;
	chunkCount: number;
	uniqueHashes: number;
	embeddingOk: boolean;
	embeddingLatencyMs?: number;
	embeddingError?: string;
	/** Did a generic smoke query return at least one result on this branch? */
	searchOk: boolean;
	searchResultCount?: number;
	searchLatencyMs?: number;
	/**
	 * Whether the database holds anything at all, ignoring branch scope. The
	 * gap between this and {@link searchOk} is what distinguishes "this branch
	 * has not been indexed" from "the index is broken".
	 */
	anyBranchOk?: boolean;
	indexModel?: string;
	indexDimensions?: number;
	/** How searches are answered: by vector index, or by scanning every row. */
	vectorIndex: VectorIndexState;
}

/**
 * Reports what the index holds and whether it actually works.
 *
 * The two liveness checks are deliberately shallow and time-boxed: `status`
 * must stay responsive even when the embedder is wedged, since diagnosing that
 * is exactly why someone runs it.
 */
export class StatusService {
	private static readonly PROBE_TIMEOUT_MS = 3000;
	/** A word generic enough to match something in any codebase. */
	private static readonly SMOKE_QUERY = "code";

	constructor(
		private readonly chunks: ChunkRepositoryPort,
		private readonly maintenance: IndexMaintenancePort,
		private readonly embedder: EmbedderPort,
		private readonly locator: ProjectLocator,
		private readonly metadata: IndexMetadataPort,
		private readonly location: DatabaseLocation,
		private readonly config: LmgrepConfig,
		private readonly cwd: string,
		private readonly configSources: readonly ConfigSource[],
		private readonly alternatives: IndexAlternatives,
	) {}

	async status(): Promise<StatusInfo> {
		// A manually targeted database is flat — no ancestor or prefix walking.
		const ancestor = this.location.isGitAware
			? this.locator.findIndexedAncestor(this.cwd)
			: undefined;
		const projectRoot = this.location.manual
			? this.location.root
			: (ancestor?.root ?? this.cwd);

		const filesByPath = await this.chunks.hashesByFile();
		const hashes = await this.chunks.allHashes();
		let chunkCount = 0;
		for (const [, list] of filesByPath) chunkCount += list.length;

		const probe = await this.probe(filesByPath.size > 0);
		const meta = this.metadata.read(
			this.location.manual
				? this.location.path
				: this.locator.databasePathFor(projectRoot),
		);

		const vectorIndex = await this.maintenance.vectorIndexState();
		const info: Omit<StatusInfo, "verdict"> = {
			projectRoot,
			prefix: ancestor?.prefix ?? "",
			databasePath: this.location.path,
			config: this.config,
			configSources: this.configSources,
			fileCount: filesByPath.size,
			chunkCount,
			uniqueHashes: hashes.size,
			...probe,
			vectorIndex,
			indexModel: meta?.model,
			indexDimensions: meta?.dimensions,
		};
		return { ...info, verdict: this.judge(info) };
	}

	/**
	 * Reduce the probes to one answer, in the order a user would care.
	 *
	 * A missing vector index is a note rather than a failure: search works, it
	 * is just answering by reading every embedding, which nothing else would
	 * tell you.
	 */
	private judge(info: Omit<StatusInfo, "verdict">): StatusVerdict {
		if (info.fileCount === 0) {
			// An empty database for the configured model usually means the
			// model changed, not that the project was never indexed.
			const absence = this.alternatives.explainAbsence();
			return absence
				? { searchable: false, reason: absence.reason, fix: absence.fix }
				: {
						searchable: false,
						reason: "This project is not indexed.",
						fix: "lmgrep index",
					};
		}
		if (!info.embeddingOk) {
			return {
				searchable: false,
				reason: `The embedding provider is unreachable — ${info.embeddingError ?? "no response"}`,
				fix: `Start the server at ${this.config.baseURL ?? "your configured baseURL"}, then retry.`,
			};
		}
		if (!info.searchOk) {
			// Manifests are per branch while chunks are shared by content, so
			// a checkout that has never been indexed searches an empty scope
			// over a full database. That is an ordinary state on a new
			// worktree or branch, and telling someone to `--reset` over it
			// would throw away a working index for no reason.
			return info.anyBranchOk
				? {
						searchable: false,
						reason: "This branch has not been indexed yet.",
						fix: "lmgrep index",
					}
				: {
						searchable: false,
						reason:
							"The index holds files but answered a test query with nothing — it is likely stale or was built with a different model.",
						fix: "lmgrep index --reset",
					};
		}
		if (!info.vectorIndex.built && info.vectorIndex.worthBuilding) {
			return {
				searchable: true,
				note:
					`Every search reads all ${info.vectorIndex.rows} embeddings — slow, and roughly the ` +
					"index's size in memory per query. `lmgrep index` builds the vector index.",
			};
		}
		return { searchable: true };
	}

	/**
	 * Embed once and reuse the vector for the search check — one roundtrip
	 * covers both, which keeps `status` cheap against a billed provider.
	 */
	private async probe(hasFiles: boolean): Promise<{
		embeddingOk: boolean;
		embeddingLatencyMs?: number;
		embeddingError?: string;
		searchOk: boolean;
		searchResultCount?: number;
		searchLatencyMs?: number;
		anyBranchOk?: boolean;
	}> {
		const deadline = Deadline.after(StatusService.PROBE_TIMEOUT_MS);

		let vector: Vector;
		let embeddingLatencyMs: number;
		try {
			const started = Date.now();
			vector = await deadline.enforce(
				this.embedder.embedQuery(StatusService.SMOKE_QUERY),
			);
			embeddingLatencyMs = Date.now() - started;
		} catch (err) {
			return {
				embeddingOk: false,
				searchOk: false,
				embeddingError: err instanceof Error ? err.message : String(err),
			};
		}

		if (!hasFiles) {
			return { embeddingOk: true, embeddingLatencyMs, searchOk: false };
		}

		try {
			const started = Date.now();
			const hits = await deadline.enforce(
				this.chunks.search({ vector, limit: 1, scopeToBranch: true }),
			);
			// Only when the scoped query found nothing: the unscoped one is a
			// second query, and it is worth running solely to tell an
			// unindexed branch apart from a broken index.
			const anyBranchOk =
				hits.length > 0
					? true
					: (
							await deadline.enforce(
								this.chunks.search({ vector, limit: 1, scopeToBranch: false }),
							)
						).length > 0;
			return {
				embeddingOk: true,
				embeddingLatencyMs,
				searchOk: hits.length > 0,
				searchResultCount: hits.length,
				searchLatencyMs: Date.now() - started,
				anyBranchOk,
			};
		} catch {
			// The embedder works; the index does not answer. That is a
			// meaningful distinction the caller reports differently.
			return { embeddingOk: true, embeddingLatencyMs, searchOk: false };
		}
	}
}
