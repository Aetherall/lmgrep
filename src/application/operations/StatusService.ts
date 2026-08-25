import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";
import type { Vector } from "../../domain/faceting/Vector.js";
import type { ChunkRepositoryPort } from "../../domain/ports/ChunkRepositoryPort.js";
import type { EmbedderPort } from "../../domain/ports/EmbedderPort.js";
import type { IndexMetadataPort } from "../../domain/ports/IndexMetadataPort.js";
import type { DatabaseLocation } from "../../domain/project/DatabaseLocation.js";
import type { ProjectLocator } from "../../domain/project/ProjectLocator.js";
import { Deadline } from "./Deadline.js";

export interface StatusInfo {
	projectRoot: string;
	prefix: string;
	config: LmgrepConfig;
	fileCount: number;
	chunkCount: number;
	uniqueHashes: number;
	embeddingOk: boolean;
	embeddingLatencyMs?: number;
	embeddingError?: string;
	/** Did a generic smoke query return at least one result? */
	searchOk: boolean;
	searchResultCount?: number;
	searchLatencyMs?: number;
	indexModel?: string;
	indexDimensions?: number;
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
		private readonly embedder: EmbedderPort,
		private readonly locator: ProjectLocator,
		private readonly metadata: IndexMetadataPort,
		private readonly location: DatabaseLocation,
		private readonly config: LmgrepConfig,
		private readonly cwd: string,
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

		return {
			projectRoot,
			prefix: ancestor?.prefix ?? "",
			config: this.config,
			fileCount: filesByPath.size,
			chunkCount,
			uniqueHashes: hashes.size,
			...probe,
			indexModel: meta?.model,
			indexDimensions: meta?.dimensions,
		};
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
			return {
				embeddingOk: true,
				embeddingLatencyMs,
				searchOk: hits.length > 0,
				searchResultCount: hits.length,
				searchLatencyMs: Date.now() - started,
			};
		} catch {
			// The embedder works; the index does not answer. That is a
			// meaningful distinction the caller reports differently.
			return { embeddingOk: true, embeddingLatencyMs, searchOk: false };
		}
	}
}
