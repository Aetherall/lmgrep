import type { LmgrepConfig } from "../domain/config/LmgrepConfig.js";
import type { ChunkerPort } from "../domain/ports/ChunkerPort.js";
import type { EmbedderPort } from "../domain/ports/EmbedderPort.js";
import type { LoggerPort } from "../domain/ports/LoggerPort.js";
import { ModelIdentity } from "../domain/project/ModelIdentity.js";
import { ProjectLocator } from "../domain/project/ProjectLocator.js";
import { AiSdkChatModel } from "../infrastructure/ai/AiSdkChatModel.js";
import { AiSdkEmbedder } from "../infrastructure/ai/AiSdkEmbedder.js";
import { LocalModelReloader } from "../infrastructure/ai/LocalModelReloader.js";
import { ConfigLoader } from "../infrastructure/fs/ConfigLoader.js";
import { DatabaseLocks } from "../infrastructure/fs/DatabaseLocks.js";
import { ConsoleLogger } from "../infrastructure/fs/Loggers.js";
import { ProjectMetadataStore } from "../infrastructure/fs/ProjectMetadataStore.js";
import { ProjectRegistry } from "../infrastructure/fs/ProjectRegistry.js";
import { StateDirectory } from "../infrastructure/fs/StateDirectory.js";
import { Workspace } from "../infrastructure/fs/Workspace.js";
import { GitClient } from "../infrastructure/git/GitClient.js";
import { ChunkRepository } from "../infrastructure/lancedb/ChunkRepository.js";
import { FileManifestRepository } from "../infrastructure/lancedb/FileManifestRepository.js";
import { IndexMaintenance } from "../infrastructure/lancedb/IndexMaintenance.js";
import { LanceTables } from "../infrastructure/lancedb/LanceTables.js";
import { TreeSitterChunker } from "../infrastructure/treesitter/TreeSitterChunker.js";
import { BranchBootstrapper } from "./indexing/BranchBootstrapper.js";
import { BranchManifestSweeper } from "./indexing/BranchManifestSweeper.js";
import { IndexBuilder } from "./indexing/IndexBuilder.js";
import { Lmgrep, type LmgrepServices } from "./Lmgrep.js";
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
	/**
	 * Where configuration problems go. Separate from the logger because these
	 * are reported before anything is wired, and because the MCP server must
	 * silence them — stdout is its transport.
	 */
	onWarning?: (message: string) => void;
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

		const loader = new ConfigLoader();
		const config: LmgrepConfig = {
			...loader.load(cwd),
			...options.config,
		};
		for (const warning of loader.warnings) options.onWarning?.(warning);

		const state = new StateDirectory();
		const git = new GitClient();
		// The model partitions the databases, so it has to be known before a
		// location can be resolved — which is why config loads first.
		const locator = new ProjectLocator(
			git,
			state,
			ModelIdentity.of(config.model),
			config.dimensions,
		);
		const location = locator.resolveDatabase(cwd, options.database);
		const metadata = new ProjectMetadataStore();
		const registry = new ProjectRegistry(state);
		const locks = new DatabaseLocks(
			state.locksDirectory(),
			location.path,
			location.root,
		);

		const tables = new LanceTables(location.path, location.branch);
		const manifest = new FileManifestRepository(tables, location.branch);
		const chunks = new ChunkRepository(tables, manifest, location.branch);
		const maintenance = new IndexMaintenance(tables, manifest);

		const embedder = options.embedder ?? new AiSdkEmbedder(config);
		const chunker = options.chunker ?? new TreeSitterChunker();
		const workspace = new Workspace();
		const reloader = new LocalModelReloader(config);

		const sweeper = new BranchManifestSweeper(manifest, git, logger);

		const builder = new IndexBuilder({
			workspace,
			chunker,
			embedder,
			chunks,
			manifest,
			maintenance,
			bootstrapper: new BranchBootstrapper(manifest, git, logger),
			sweeper,
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
			// The sidecar says what this database is; the registry says that
			// it exists. Nothing walks the filesystem looking for databases
			// now that they live inside repositories, so an index that is
			// never registered is one `lmgrep projects` and cross-project
			// search cannot see.
			registerIndex: () => {
				const project = locator.resolveProject(cwd);
				registry.record({
					root: locator.projectRootFor(cwd),
					name: location.manual ? options.database : undefined,
					remote: project.remote,
					databasePath: location.path,
					model: config.model,
					dimensions: metadata.read(location.path)?.dimensions,
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
			registry,
			embedder,
			chunker,
			builder,
			sweeper,
			searcher,
			statusReporter: new StatusService(
				chunks,
				maintenance,
				embedder,
				locator,
				metadata,
				location,
				config,
				cwd,
				loader.sources,
			),
			watcher: new WatchService(builder, workspace, config, cwd, logger, locks),
			researcher: new ResearchAgent(
				searcher,
				new AiSdkChatModel(config),
				config,
			),
			projectId: () => locator.resolveProject(cwd).id,
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
