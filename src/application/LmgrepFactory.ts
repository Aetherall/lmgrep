import type { LmgrepConfig } from "../domain/config/LmgrepConfig.js";
import type { ChunkerPort } from "../domain/ports/ChunkerPort.js";
import type { EmbedderPort } from "../domain/ports/EmbedderPort.js";
import type { LoggerPort } from "../domain/ports/LoggerPort.js";
import { ProjectLocator } from "../domain/project/ProjectLocator.js";
import { AiSdkChatModel } from "../infrastructure/ai/AiSdkChatModel.js";
import { AiSdkEmbedder } from "../infrastructure/ai/AiSdkEmbedder.js";
import { LocalModelReloader } from "../infrastructure/ai/LocalModelReloader.js";
import { ConfigLoader } from "../infrastructure/fs/ConfigLoader.js";
import { DatabaseLocks } from "../infrastructure/fs/DatabaseLocks.js";
import { FacetSessionStore } from "../infrastructure/fs/FacetSessionStore.js";
import { ConsoleLogger } from "../infrastructure/fs/Loggers.js";
import { ProjectMetadataStore } from "../infrastructure/fs/ProjectMetadataStore.js";
import { StateDirectory } from "../infrastructure/fs/StateDirectory.js";
import { Workspace } from "../infrastructure/fs/Workspace.js";
import { GitClient } from "../infrastructure/git/GitClient.js";
import { ChunkRepository } from "../infrastructure/lancedb/ChunkRepository.js";
import { FileManifestRepository } from "../infrastructure/lancedb/FileManifestRepository.js";
import { IndexMaintenance } from "../infrastructure/lancedb/IndexMaintenance.js";
import { LanceTables } from "../infrastructure/lancedb/LanceTables.js";
import { VocabRepository } from "../infrastructure/lancedb/VocabRepository.js";
import { TreeSitterChunker } from "../infrastructure/treesitter/TreeSitterChunker.js";
import { FacetEngine } from "./faceting/FacetEngine.js";
import { FacetNavigator } from "./faceting/FacetNavigator.js";
import { BranchBootstrapper } from "./indexing/BranchBootstrapper.js";
import { BranchManifestSweeper } from "./indexing/BranchManifestSweeper.js";
import { IndexBuilder } from "./indexing/IndexBuilder.js";
import { VocabularyBuilder } from "./indexing/VocabularyBuilder.js";
import { Lmgrep, type LmgrepServices } from "./Lmgrep.js";
import { RepairService } from "./operations/RepairService.js";
import { StatusService } from "./operations/StatusService.js";
import { WatchService } from "./operations/WatchService.js";
import { ResearchAgent } from "./research/ResearchAgent.js";
import { SearchService } from "./search/SearchService.js";
import {
	type ForeignIndexOpener,
	SearchTargetResolver,
} from "./search/SearchTargetResolver.js";

export interface LmgrepOptions {
	cwd: string;
	/**
	 * Target a specific database instead of the git-aware default. A bare name
	 * creates an independent index; a path points at a database directory.
	 */
	database?: string;
	config?: Partial<LmgrepConfig>;
	embedder?: EmbedderPort;
	chunker?: ChunkerPort;
	logger?: LoggerPort;
}

/**
 * Assembles a working {@link Lmgrep}.
 *
 * This is the only place that knows the full object graph. Everything else
 * receives its collaborators, which is what keeps the layers testable and the
 * dependency direction one-way.
 */
export class LmgrepFactory {
	async open(options: LmgrepOptions): Promise<Lmgrep> {
		const { cwd } = options;
		const logger = options.logger ?? new ConsoleLogger();

		const config: LmgrepConfig = {
			...new ConfigLoader().load(cwd),
			...options.config,
		};

		const state = new StateDirectory();
		const git = new GitClient();
		const locator = new ProjectLocator(git, state);
		const location = locator.resolveDatabase(cwd, options.database);
		const metadata = new ProjectMetadataStore(state);
		const locks = new DatabaseLocks(location.path);

		const tables = new LanceTables(location.path, location.branch);
		const manifest = new FileManifestRepository(tables, location.branch);
		const chunks = new ChunkRepository(tables, manifest, location.branch);
		const vocab = new VocabRepository(tables);
		const maintenance = new IndexMaintenance(tables, manifest);

		const embedder = options.embedder ?? new AiSdkEmbedder(config);
		const chunker = options.chunker ?? new TreeSitterChunker();
		const workspace = new Workspace();
		const reloader = new LocalModelReloader(config);

		const vocabulary = new VocabularyBuilder(vocab, embedder, logger);

		const builder = new IndexBuilder({
			workspace,
			chunker,
			embedder,
			chunks,
			manifest,
			maintenance,
			vocabulary,
			bootstrapper: new BranchBootstrapper(manifest, git, logger),
			sweeper: new BranchManifestSweeper(manifest, git, logger),
			logger,
			config,
			location,
			locks,
			recordMetadata: (dimensions) => {
				const project = locator.resolveProject(cwd);
				metadata.write(location.path, {
					root: project.root,
					remote: project.remote,
					branch: location.branch.toString(),
					model: config.model,
					dimensions,
				});
			},
			reloadModel: () => reloader.reload(),
			isLocalProvider: reloader.isLocal,
		});

		const searcher = new SearchService(
			embedder,
			new SearchTargetResolver(
				cwd,
				chunks,
				location,
				locator,
				this.foreignOpener(locator),
			),
			config,
			logger,
			() => metadata.read(location.path),
		);

		const facets = new FacetNavigator(
			embedder,
			chunks,
			vocab,
			new FacetEngine(vocab),
			new FacetSessionStore(state),
			() => locator.resolveProject(cwd).id,
		);

		const services: LmgrepServices = {
			cwd,
			config,
			location,
			locator,
			logger,
			tables,
			chunks,
			manifest,
			maintenance,
			metadata,
			embedder,
			chunker,
			builder,
			searcher,
			facets,
			vocabulary,
			repairer: new RepairService(workspace, chunks, manifest, logger),
			statusReporter: new StatusService(
				chunks,
				embedder,
				locator,
				metadata,
				location,
				config,
				cwd,
			),
			watcher: new WatchService(builder, workspace, config, cwd, logger, locks),
			researcher: new ResearchAgent(
				searcher,
				new AiSdkChatModel(config),
				config,
			),
			projectId: () => locator.resolveProject(cwd).id,
			vocabCount: () => vocab.count(),
			dropVocab: () => vocab.drop(),
			chunkCount: () => chunks.count(),
			streamChunkTexts: () => chunks.streamTexts(),
		};

		return new Lmgrep(services);
	}

	/**
	 * Opens another project's database read-only for cross-project search.
	 *
	 * Foreign indexes get their own connection and are closed after the query,
	 * so a `--across` over many projects does not leave native runtimes open.
	 */
	private foreignOpener(locator: ProjectLocator): ForeignIndexOpener {
		return {
			async open(projectPath: string) {
				const project = locator.resolveProject(projectPath);
				const tables = new LanceTables(
					locator.databasePathFor(projectPath),
					project.branch,
				);
				const manifest = new FileManifestRepository(tables, project.branch);
				return {
					chunks: new ChunkRepository(tables, manifest, project.branch),
					close: async () => tables.close(),
				};
			},
		};
	}
}
