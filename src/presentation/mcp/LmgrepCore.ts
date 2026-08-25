import type { Lmgrep } from "../../application/Lmgrep.js";
import { LmgrepFactory } from "../../application/LmgrepFactory.js";
import {
	HealthMonitor,
	type HealthState,
} from "../../application/operations/HealthMonitor.js";
import { AiSdkChatModel } from "../../infrastructure/ai/AiSdkChatModel.js";
import { SilentLogger } from "../../infrastructure/fs/Loggers.js";
import { ProjectRegistry } from "../../infrastructure/fs/ProjectRegistry.js";
import { StateDirectory } from "../../infrastructure/fs/StateDirectory.js";
import { HitFormatter } from "./HitFormatter.js";
import { IndexWatchController } from "./IndexWatchController.js";
import { ToolDescriptions } from "./ToolDescriptions.js";

export type { HealthState } from "../../application/operations/HealthMonitor.js";

export interface SearchArgs {
	query: string;
	limit?: number;
	filePrefix?: string;
	type?: string[];
	language?: string[];
	project?: string;
}

export interface ToolResult {
	text: string;
	isError?: boolean;
}

/** An indexed project other than the current one. */
export interface OtherProject {
	root: string;
	remote?: string;
}

/**
 * The tool surface shared by the MCP server and the Pi extension.
 *
 * It owns the health story: an agent must be told, in the tool description
 * itself, when search cannot work and what to do instead — a tool that silently
 * returns nothing teaches the agent to stop using it.
 */
export class LmgrepCore {
	private constructor(
		private readonly lmgrep: Lmgrep,
		private readonly health: HealthMonitor,
		private readonly watching: IndexWatchController,
		private readonly registry: ProjectRegistry,
		readonly askAvailable: boolean,
	) {}

	static async open(options: {
		cwd: string;
		database?: string;
	}): Promise<LmgrepCore> {
		const lmgrep = await new LmgrepFactory().open({
			cwd: options.cwd,
			database: options.database,
			// stdout is the MCP transport; a stray log line corrupts it, and
			// that includes configuration warnings.
			logger: new SilentLogger(),
			onWarning: () => {},
		});
		const registry = new ProjectRegistry(new StateDirectory());

		const isIndexed = () => lmgrep.isIndexed();
		const watching = new IndexWatchController(lmgrep, isIndexed);

		const health = new HealthMonitor(
			{
				isIndexed,
				inspect: async () => {
					const info = await lmgrep.status();
					return {
						fileCount: info.fileCount,
						embeddingOk: info.embeddingOk,
						searchOk: info.searchOk,
					};
				},
				ensureWatching: () => watching.ensureStarted(),
			},
			lmgrep.config,
		);

		return new LmgrepCore(
			lmgrep,
			health,
			watching,
			registry,
			// `ask` needs a chat model on top of the embedder; only expose the
			// tool when one is configured, so agents never see a tool they
			// cannot use.
			new AiSdkChatModel(lmgrep.config).isConfigured,
		);
	}

	get cwd(): string {
		return this.lmgrep.cwd;
	}

	get searchParams(): typeof ToolDescriptions.SEARCH_PARAMS {
		return ToolDescriptions.SEARCH_PARAMS;
	}

	get listProjectsDescription(): string {
		return ToolDescriptions.LIST_PROJECTS;
	}

	get askParam(): { description: string } {
		return ToolDescriptions.ASK_PARAM;
	}

	get askDescription(): string {
		return ToolDescriptions.ASK;
	}

	currentHealth(): HealthState {
		return this.health.current;
	}

	onHealthChange(listener: (state: HealthState) => void): () => void {
		return this.health.onChange(listener);
	}

	start(): void {
		this.health.start();
	}

	buildSearchDescription(): string {
		const state = this.health.current;
		if (state.healthy) return ToolDescriptions.SEARCH_HEALTHY;
		return ToolDescriptions.unavailable(
			state.reason,
			this.otherProjects().length > 0,
		);
	}

	async executeSearch(args: SearchArgs): Promise<ToolResult> {
		return this.guarded(async () => {
			const hits = await this.lmgrep.search(args.query, {
				limit: args.limit ?? ToolDescriptions.SEARCH_PARAMS.limit.default,
				filePrefix: args.filePrefix,
				type: args.type,
				language: args.language,
				project: args.project,
			});

			// A successful search proves the embedder is reachable and the index
			// is queryable — no need to keep pinging and keep it awake.
			this.health.markHealthy();

			return hits.isEmpty
				? { text: "No results found." }
				: { text: HitFormatter.hits(hits.toArray()) };
		});
	}

	async executeAsk(args: { question: string }): Promise<ToolResult> {
		if (this.health.current.reason === "embedding_failed") {
			return { text: ToolDescriptions.EMBEDDER_DOWN, isError: true };
		}
		try {
			const result = await this.lmgrep.ask(args.question);
			// A completed run proves the embedder and index are both healthy.
			this.health.markHealthy();
			return { text: HitFormatter.answer(result) };
		} catch (err) {
			// research() degrades internally for provider and search errors; it
			// only throws when no chat model is configured, which is worth
			// surfacing verbatim.
			return {
				text: `Error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	}

	async executeListProjects(): Promise<ToolResult> {
		const others = this.otherProjects();
		return others.length === 0
			? { text: "No other indexed projects found." }
			: { text: HitFormatter.projects(others) };
	}

	async dispose(): Promise<void> {
		this.health.dispose();
		this.watching.release();
		await this.lmgrep.close();
	}

	/** Shared failure handling: report, and arm recovery polling. */
	private async guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
		if (this.health.current.reason === "embedding_failed") {
			return { text: ToolDescriptions.EMBEDDER_DOWN, isError: true };
		}
		try {
			return await run();
		} catch (err) {
			// The embedder may be down; poll so recovery updates the tool
			// description without the user restarting anything.
			this.health.markFailed();
			return {
				text: `Error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	}

	/**
	 * Projects an agent can actually reach with the `project` parameter.
	 *
	 * Standalone indexes are excluded: they are addressed by name, and their
	 * recorded root is merely where they were built from, so offering one as a
	 * project path would resolve to a different database.
	 */
	private otherProjects(): OtherProject[] {
		const current = this.lmgrep.location.path;
		const seen = new Set<string>();
		const out: OtherProject[] = [];
		for (const entry of this.registry.list()) {
			if (entry.name || entry.databasePath === current) continue;
			if (seen.has(entry.root)) continue;
			seen.add(entry.root);
			out.push({ root: entry.root, remote: entry.remote });
		}
		return out;
	}
}
