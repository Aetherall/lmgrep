import { existsSync } from "node:fs";
import { createIndex, type LmgrepIndex } from "../index.js";
import { TreeSitterChunker } from "./chunker/index.js";
import { loadConfig } from "./config.js";
import { AISDKEmbedder } from "./embedder.js";
import { startWatcher } from "./serve.js";
import {
	discoverIndexedProjects,
	findIndexedAncestor,
	getDbPath,
	Store,
} from "./store.js";
import { silentLogger } from "./types.js";

export type HealthReason =
	| "ok"
	| "not_indexed"
	| "embedding_failed"
	| "search_empty";

export interface HealthState {
	healthy: boolean;
	reason: HealthReason;
}

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

export interface ParamSpec {
	description: string;
}

export interface SearchParamSpecs {
	query: ParamSpec;
	limit: ParamSpec & { default: number };
	filePrefix: ParamSpec;
	type: ParamSpec;
	language: ParamSpec;
	project: ParamSpec;
}

export const searchParamSpecs: SearchParamSpecs = {
	query: {
		description:
			'Natural-language description of what you\'re looking for — phrase it as a question or intent, not keywords. Good: "how are webhooks authenticated", "where is user deletion handled", "what happens when a record is created". Bad: "webhook auth", "deleteUser", "createRecord".',
	},
	limit: {
		description: "Maximum number of results",
		default: 10,
	},
	filePrefix: {
		description: "Restrict to files under this path (e.g. 'src/lib')",
	},
	type: {
		description:
			"AST node types to filter by (e.g. ['function_declaration', 'class_declaration'])",
	},
	language: {
		description: "File extensions to filter by (e.g. ['.ts', '.py'])",
	},
	project: {
		description:
			"Search a different indexed project by its root path instead of the current one",
	},
};

export const listProjectsDescription =
	"List all indexed projects other than the current one. " +
	"Use this to discover what projects are available for cross-project search " +
	"via the `project` parameter on the search tool.";

export interface LmgrepCore {
	readonly cwd: string;
	readonly searchParams: SearchParamSpecs;
	readonly listProjectsDescription: string;
	buildSearchDescription(): string;
	currentHealth(): HealthState;
	onHealthChange(cb: (state: HealthState) => void): () => void;
	startHealthLoop(): void;
	executeSearch(args: SearchArgs): Promise<ToolResult>;
	executeListProjects(): Promise<ToolResult>;
	dispose(): Promise<void>;
}

export async function createLmgrepCore(opts: {
	cwd: string;
}): Promise<LmgrepCore> {
	const cwd = opts.cwd;
	const index: LmgrepIndex = await createIndex({ cwd });

	function isCurrentProjectIndexed(): boolean {
		if (findIndexedAncestor(cwd)) return true;
		return existsSync(getDbPath(cwd));
	}

	function getOtherProjects(): Array<{ root: string; remote?: string }> {
		const currentDb = getDbPath(cwd);
		return discoverIndexedProjects()
			.filter((p) => getDbPath(p.metadata.root) !== currentDb)
			.map((p) => ({ root: p.metadata.root, remote: p.metadata.remote }));
	}

	async function checkHealth(): Promise<HealthState> {
		if (!isCurrentProjectIndexed()) {
			return { healthy: false, reason: "not_indexed" };
		}
		try {
			const info = await index.status();
			if (info.fileCount === 0) {
				return { healthy: false, reason: "not_indexed" };
			}
			if (!info.embeddingOk) {
				return { healthy: false, reason: "embedding_failed" };
			}
			if (!info.searchOk) {
				return { healthy: false, reason: "search_empty" };
			}
			return { healthy: true, reason: "ok" };
		} catch {
			return { healthy: false, reason: "embedding_failed" };
		}
	}

	let state: HealthState = isCurrentProjectIndexed()
		? { healthy: true, reason: "ok" }
		: { healthy: false, reason: "not_indexed" };

	const listeners = new Set<(s: HealthState) => void>();
	let stopWatcher: (() => void) | undefined;
	let pollTimer: NodeJS.Timeout | undefined;
	let disposed = false;

	function tryStartWatcher(): void {
		if (stopWatcher) return;
		if (!isCurrentProjectIndexed()) return;
		const config = loadConfig(cwd);
		const store = Store.forProject(cwd);
		const embedder = new AISDKEmbedder(config);
		const chunker = new TreeSitterChunker();
		stopWatcher = startWatcher(
			cwd,
			store,
			config,
			embedder,
			chunker,
			silentLogger,
		);
	}

	function buildSearchDescription(): string {
		if (state.healthy) {
			return [
				"**lmgrep — primary search tool for this codebase.** Semantic code search powered by a local embedding model; lmgrep understands intent, not string patterns. Prefer lmgrep over Grep/Glob/find/ripgrep for almost all exploration and lookup tasks.",
				"",
				'**Use lmgrep for:** finding where something is handled, how something works, locating relevant code, discovering related files, understanding unfamiliar code, tracing side effects, finding usage patterns, answering "where is X?" or "how does Y work?". One good lmgrep query is usually enough to understand how to proceed.',
				"",
				"**Query lmgrep as natural questions or intent descriptions**, not keyword dumps:",
				'- "how are webhooks authenticated" → finds middleware, token validation, auth checks',
				'- "where is user deletion handled" → finds the handler and related cleanup logic',
				'- "what happens when a record is created" → finds controllers, event emitters, side effects',
				'- "config loading and validation"',
				'- "how to run the playwright tests" → finds config, scripts, prerequisites',
				"",
				"**lmgrep results include** file paths, line numbers, AST node types, and surrounding context (scope, leading comments, role) — often enough to act on directly without re-reading the file. Trust lmgrep results; don't follow up with Glob/Read on files already surfaced by lmgrep unless you genuinely need content that wasn't returned.",
				"",
				"**Fall back to Grep only** when you need exact string or regex matches (specific identifiers, literal constants, error messages, TODO markers). Don't use Grep/Glob/find for conceptual or intent-based search — lmgrep will do better.",
			].join("\n");
		}

		const others = getOtherProjects();
		const suffix =
			others.length > 0
				? " You can still search other indexed projects via the `project` parameter — call `list_other_indexed_projects` to see what's available."
				: "";

		switch (state.reason) {
			case "not_indexed":
				return (
					"This project is not indexed. Semantic search is not available for the current directory." +
					suffix
				);
			case "embedding_failed":
				return (
					"The embedding provider is unreachable. Semantic search is temporarily unavailable for the current directory." +
					suffix
				);
			case "search_empty":
				return (
					"The index for the current branch appears empty or stale — a smoke query returned no results. Re-run `lmgrep index` to rebuild." +
					suffix
				);
			default:
				return "Semantic search is unavailable." + suffix;
		}
	}

	async function refreshHealth(): Promise<void> {
		if (disposed) return;
		const next = await checkHealth();
		if (next.healthy !== state.healthy || next.reason !== state.reason) {
			state = next;
			for (const cb of listeners) cb(next);
		}
		if (next.healthy) tryStartWatcher();
	}

	function startHealthLoop(): void {
		if (pollTimer) return;
		tryStartWatcher();
		// Non-local providers may bill per request — poll less often.
		const intervalMs = index.config.local ? 10_000 : 60_000;
		refreshHealth();
		pollTimer = setInterval(refreshHealth, intervalMs);
	}

	async function executeSearch(args: SearchArgs): Promise<ToolResult> {
		if (state.reason === "embedding_failed") {
			return {
				text: "lmgrep is unavailable: the embedding provider is unreachable. Ask the user to check their lmgrep configuration (`lmgrep status`) before retrying.",
				isError: true,
			};
		}
		try {
			const results = await index.search(args.query, {
				limit: args.limit ?? searchParamSpecs.limit.default,
				filePrefix: args.filePrefix,
				type: args.type,
				language: args.language,
				project: args.project,
			});

			if (results.length === 0) {
				return { text: "No results found." };
			}

			const text = results
				.map((r) => {
					const loc = `${r.filePath}:${r.startLine}-${r.endLine}`;
					const header = `${loc} [${r.type}] ${r.name} (score: ${r.score.toFixed(3)})`;
					const parts = [header];
					if (r.context) parts.push(r.context);
					parts.push(r.content);
					return parts.join("\n");
				})
				.join("\n\n---\n\n");

			return { text };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { text: `Error: ${msg}`, isError: true };
		}
	}

	async function executeListProjects(): Promise<ToolResult> {
		const others = getOtherProjects();
		if (others.length === 0) {
			return { text: "No other indexed projects found." };
		}
		const lines = others.map((p) => {
			const parts = [p.root];
			if (p.remote) parts.push(`(${p.remote})`);
			return `- ${parts.join(" ")}`;
		});
		return { text: `Indexed projects:\n${lines.join("\n")}` };
	}

	async function dispose(): Promise<void> {
		disposed = true;
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		stopWatcher?.();
		stopWatcher = undefined;
		listeners.clear();
		await index.close();
	}

	return {
		cwd,
		searchParams: searchParamSpecs,
		listProjectsDescription,
		buildSearchDescription,
		currentHealth: () => state,
		onHealthChange(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		startHealthLoop,
		executeSearch,
		executeListProjects,
		dispose,
	};
}
