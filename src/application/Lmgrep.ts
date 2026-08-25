import { existsSync } from "node:fs";
import type { LmgrepConfig } from "../domain/config/LmgrepConfig.js";
import type { FileManifest } from "../domain/corpus/SourceFile.js";
import type { ChunkerPort } from "../domain/ports/ChunkerPort.js";
import type { ChunkRepositoryPort } from "../domain/ports/ChunkRepositoryPort.js";
import type { EmbedderPort } from "../domain/ports/EmbedderPort.js";
import type { FileManifestRepositoryPort } from "../domain/ports/FileManifestRepositoryPort.js";
import type {
	IndexMaintenancePort,
	OptimizeReport,
} from "../domain/ports/IndexMaintenancePort.js";
import type { LoggerPort } from "../domain/ports/LoggerPort.js";
import type { DatabaseLocation } from "../domain/project/DatabaseLocation.js";
import type { ProjectId } from "../domain/project/ProjectId.js";
import type { ProjectLocator } from "../domain/project/ProjectLocator.js";
import type { TraceEntry } from "../domain/research/ResearchTrace.js";
import type { HitList } from "../domain/retrieval/HitList.js";
import type { ProjectMetadataStore } from "../infrastructure/fs/ProjectMetadataStore.js";
import type { LanceTables } from "../infrastructure/lancedb/LanceTables.js";
import type {
	FacetContents,
	FacetNavigator,
	FacetOptions,
	FacetOverview,
	FacetView,
} from "./faceting/FacetNavigator.js";
import type { IndexBuilder } from "./indexing/IndexBuilder.js";
import type {
	IndexBuildOptions,
	IndexBuildResult,
} from "./indexing/IndexingProgress.js";
import type { VocabularyBuilder } from "./indexing/VocabularyBuilder.js";
import type {
	RepairResult,
	RepairService,
} from "./operations/RepairService.js";
import type { StatusInfo, StatusService } from "./operations/StatusService.js";
import type { WatchService } from "./operations/WatchService.js";
import type {
	ResearchAgent,
	ResearchResult,
} from "./research/ResearchAgent.js";
import { SearchCriteria, type SearchOptions } from "./search/SearchCriteria.js";
import type { SearchService } from "./search/SearchService.js";

/** Everything an Lmgrep instance owns, assembled by the composition root. */
export interface LmgrepServices {
	cwd: string;
	config: LmgrepConfig;
	location: DatabaseLocation;
	locator: ProjectLocator;
	logger: LoggerPort;
	tables: LanceTables;
	chunks: ChunkRepositoryPort;
	manifest: FileManifestRepositoryPort;
	maintenance: IndexMaintenancePort;
	metadata: ProjectMetadataStore;
	embedder: EmbedderPort;
	chunker: ChunkerPort;
	builder: IndexBuilder;
	searcher: SearchService;
	facets: FacetNavigator;
	vocabulary: VocabularyBuilder;
	repairer: RepairService;
	statusReporter: StatusService;
	watcher: WatchService;
	researcher: ResearchAgent;
	projectId: () => ProjectId;
	vocabCount: () => Promise<number>;
	dropVocab: () => Promise<void>;
	chunkCount: () => Promise<number>;
	streamChunkTexts: () => AsyncGenerator<
		Array<{ name: string; content: string }>
	>;
}

/**
 * The application façade: one object exposing every operation the CLI, the MCP
 * server and the Pi extension need.
 *
 * It holds no logic of its own — each method delegates to the service that
 * owns that behaviour. Its job is to be the single place where a caller
 * acquires a working, wired-up lmgrep, so no entry point has to know the
 * assembly order.
 */
export class Lmgrep {
	constructor(private readonly services: LmgrepServices) {}

	get cwd(): string {
		return this.services.cwd;
	}

	get config(): LmgrepConfig {
		return this.services.config;
	}

	get location(): DatabaseLocation {
		return this.services.location;
	}

	build(options: IndexBuildOptions = {}): Promise<IndexBuildResult> {
		return this.services.builder.build(options);
	}

	search(query: string, options: SearchOptions = {}): Promise<HitList> {
		return this.services.searcher.search(query, new SearchCriteria(options));
	}

	facet(query: string, options: FacetOptions = {}): Promise<FacetOverview> {
		return this.services.facets.overview(query, options);
	}

	facetSearch(query: string, options: FacetOptions = {}): Promise<FacetView> {
		return this.services.facets.startSession(query, options);
	}

	facetList(path: string): Promise<FacetView> {
		return this.services.facets.list(path);
	}

	facetShow(path: string): Promise<FacetContents> {
		return this.services.facets.show(path);
	}

	facetRefine(path: string, options: FacetOptions = {}): Promise<FacetView> {
		return this.services.facets.refine(path, options);
	}

	/**
	 * Rebuild the vocabulary from every indexed chunk. Separate from `build`
	 * because document frequency computed over a delta is meaningless — the
	 * whole corpus has to be counted at once.
	 */
	async facetIndex(
		options: { minDf?: number; reset?: boolean } = {},
	): Promise<{ added: number; total: number }> {
		if (options.reset) await this.services.dropVocab();

		const chunkCount = await this.services.chunkCount();
		if (chunkCount === 0) {
			this.services.logger.info("No chunks indexed. Run `lmgrep index` first.");
			return { added: 0, total: 0 };
		}

		this.services.logger.info(
			`Building vocab from ${chunkCount} chunks (minDf=${options.minDf ?? 10})...`,
		);

		const texts: Array<{ name: string; content: string }> = [];
		for await (const batch of this.services.streamChunkTexts()) {
			texts.push(...batch);
		}

		const { added } = await this.services.vocabulary.build(texts, {
			minDf: options.minDf,
		});
		return { added, total: await this.services.vocabCount() };
	}

	ask(
		question: string,
		onTrace?: (entry: TraceEntry) => void,
	): Promise<ResearchResult> {
		return this.services.researcher.research(question, onTrace);
	}

	repair(dryRun = false): Promise<RepairResult> {
		return this.services.repairer.repair(this.services.cwd, dryRun);
	}

	status(): Promise<StatusInfo> {
		return this.services.statusReporter.status();
	}

	/** Start watching; returns a function that stops it. */
	watch(): () => void {
		return this.services.watcher.start();
	}

	/** The current branch's file manifest, for change previews. */
	currentManifest(): Promise<FileManifest> {
		return this.services.manifest.current();
	}

	optimize(): Promise<OptimizeReport> {
		return this.services.maintenance.compact();
	}

	get maintenance(): IndexMaintenancePort {
		return this.services.maintenance;
	}

	get projectId(): ProjectId {
		return this.services.projectId();
	}

	/**
	 * Whether this working directory has a usable index.
	 *
	 * An indexed ancestor counts: running from a subdirectory of an indexed
	 * tree is ordinary, and reporting it as unindexed would disable search for
	 * no reason. A manually targeted database is flat, so only its own path
	 * matters.
	 */
	isIndexed(): boolean {
		if (this.services.location.manual) {
			return existsSync(this.services.location.path);
		}
		if (this.services.locator.findIndexedAncestor(this.services.cwd)) {
			return true;
		}
		return existsSync(this.services.location.path);
	}

	async close(): Promise<void> {
		this.services.tables.close();
	}
}
