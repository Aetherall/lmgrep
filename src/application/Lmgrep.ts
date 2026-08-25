import { existsSync } from "node:fs";
import type { LmgrepConfig } from "../domain/config/LmgrepConfig.js";
import type { FileManifest } from "../domain/corpus/SourceFile.js";
import type { ChunkerPort } from "../domain/ports/ChunkerPort.js";
import type { ChunkRepositoryPort } from "../domain/ports/ChunkRepositoryPort.js";
import type { DatabaseSessionPort } from "../domain/ports/DatabaseSessionPort.js";
import type { EmbedderPort } from "../domain/ports/EmbedderPort.js";
import type { FileManifestRepositoryPort } from "../domain/ports/FileManifestRepositoryPort.js";
import type {
	DedupeReport,
	IndexMaintenancePort,
	OptimizeReport,
} from "../domain/ports/IndexMaintenancePort.js";
import type { IndexMetadataPort } from "../domain/ports/IndexMetadataPort.js";
import type { LoggerPort } from "../domain/ports/LoggerPort.js";
import type { ProjectRegistryPort } from "../domain/ports/ProjectRegistryPort.js";
import type { DatabaseLocation } from "../domain/project/DatabaseLocation.js";
import type { ProjectId } from "../domain/project/ProjectId.js";
import type { ProjectLocator } from "../domain/project/ProjectLocator.js";
import type { TraceEntry } from "../domain/research/ResearchTrace.js";
import type { HitList } from "../domain/retrieval/HitList.js";
import type { BranchManifestSweeper } from "./indexing/BranchManifestSweeper.js";
import type { IndexBuilder } from "./indexing/IndexBuilder.js";
import type {
	IndexBuildOptions,
	IndexBuildResult,
} from "./indexing/IndexingProgress.js";
import type { IndexAlternatives } from "./operations/IndexAlternatives.js";
import type { StatusInfo, StatusService } from "./operations/StatusService.js";
import type { WatchService } from "./operations/WatchService.js";
import type {
	ResearchAgent,
	ResearchResult,
} from "./research/ResearchAgent.js";
import { SearchCriteria, type SearchOptions } from "./search/SearchCriteria.js";
import type { SearchService } from "./search/SearchService.js";

/** What a maintenance pass changed. */
export interface TidyReport {
	deduped: DedupeReport;
	optimized: OptimizeReport;
}

/** Everything an Lmgrep instance owns, assembled by the composition root. */
export interface LmgrepServices {
	cwd: string;
	config: LmgrepConfig;
	location: DatabaseLocation;
	locator: ProjectLocator;
	logger: LoggerPort;
	tables: DatabaseSessionPort;
	chunks: ChunkRepositoryPort;
	manifest: FileManifestRepositoryPort;
	maintenance: IndexMaintenancePort;
	metadata: IndexMetadataPort;
	registry: ProjectRegistryPort;
	alternatives: IndexAlternatives;
	embedder: EmbedderPort;
	chunker: ChunkerPort;
	builder: IndexBuilder;
	sweeper: BranchManifestSweeper;
	searcher: SearchService;
	statusReporter: StatusService;
	watcher: WatchService;
	researcher: ResearchAgent;
	projectId: () => ProjectId;
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

	ask(
		question: string,
		onTrace?: (entry: TraceEntry) => void,
	): Promise<ResearchResult> {
		return this.services.researcher.research(question, onTrace);
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

	/**
	 * Everything the index needs done to it that is not indexing: drop dead
	 * branches' manifests, remove duplicate and superseded rows, compact the
	 * fragments, and train the vector index if the table has grown into
	 * wanting one.
	 *
	 * These were three separate commands. They are one call because they are
	 * one intent and because the order between them is not optional: `dedupe`
	 * keeps any chunk version some manifest still references, so sweeping dead
	 * branches has to happen first or their leftover rows shield their own
	 * orphaned chunks from collection.
	 */
	async tidy(): Promise<TidyReport> {
		await this.services.sweeper.sweep(this.services.location.root);
		const deduped = await this.services.maintenance.dedupe();
		const optimized = await this.services.maintenance.compact();
		return { deduped, optimized };
	}

	get maintenance(): IndexMaintenancePort {
		return this.services.maintenance;
	}

	/** Every index this machine knows about. */
	get registry(): ProjectRegistryPort {
		return this.services.registry;
	}

	/** This project's indexes under other embedding models. */
	get alternatives(): IndexAlternatives {
		return this.services.alternatives;
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
