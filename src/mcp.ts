#!/usr/bin/env node
process.title = "lmgrep-mcp";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createIndex } from "./index.js";
import {
	findIndexedAncestor,
	discoverIndexedProjects,
	getDbPath,
} from "./lib/store.js";
import { startWatcher } from "./lib/serve.js";
import { loadConfig } from "./lib/config.js";
import { AISDKEmbedder } from "./lib/embedder.js";
import { TreeSitterChunker } from "./lib/chunker/index.js";
import { Store } from "./lib/store.js";
import { existsSync } from "node:fs";
import { silentLogger } from "./lib/types.js";

const cwd = process.cwd();

// --- Index state ---

function isCurrentProjectIndexed(): boolean {
	const ancestor = findIndexedAncestor(cwd);
	if (ancestor) return true;
	return existsSync(getDbPath(cwd));
}

function getOtherProjects(): Array<{ root: string; remote?: string }> {
	const currentDb = getDbPath(cwd);
	return discoverIndexedProjects()
		.filter((p) => {
			const pDb = getDbPath(p.metadata.root);
			return pDb !== currentDb;
		})
		.map((p) => ({
			root: p.metadata.root,
			remote: p.metadata.remote,
		}));
}

function buildSearchDescription(): string {
	if (isCurrentProjectIndexed()) {
		return (
			"Search the codebase using semantic similarity. " +
			"Returns code chunks with file paths, line numbers, and context. " +
			"Use natural language queries describing what you're looking for. " +
			"Results are ranked by relevance."
		);
	}

	const others = getOtherProjects();
	let desc =
		"This project is not indexed. Semantic search is not available for the current directory.";
	if (others.length > 0) {
		desc +=
			" However, you can search other indexed projects using the `project` parameter." +
			" Use the `list_other_indexed_projects` tool to see what's available.";
	}
	return desc;
}

// --- In-process watcher ---

let stopWatcher: (() => void) | undefined;

function tryStartWatcher(): void {
	if (stopWatcher) return; // already watching
	if (!isCurrentProjectIndexed()) return;

	const config = loadConfig(cwd);
	const store = Store.forProject(cwd);
	const embedder = new AISDKEmbedder(config);
	const chunker = new TreeSitterChunker();

	stopWatcher = startWatcher(cwd, store, config, embedder, chunker, silentLogger);
	// undefined means lock was held by another process — that's fine
}

// --- MCP server ---

const server = new McpServer({
	name: "lmgrep",
	version: "0.1.0",
});

const index = await createIndex({ cwd });

const searchTool = server.tool(
	"search",
	buildSearchDescription(),
	{
		query: z.string().describe("What you're looking for, in natural language"),
		limit: z
			.number()
			.optional()
			.default(10)
			.describe("Maximum number of results"),
		filePrefix: z
			.string()
			.optional()
			.describe("Restrict to files under this path (e.g. 'src/lib')"),
		type: z
			.array(z.string())
			.optional()
			.describe(
				"AST node types to filter by (e.g. ['function_declaration', 'class_declaration'])",
			),
		language: z
			.array(z.string())
			.optional()
			.describe("File extensions to filter by (e.g. ['.ts', '.py'])"),
		project: z
			.string()
			.optional()
			.describe(
				"Search a different indexed project by its root path instead of the current one",
			),
	},
	async ({ query, limit, filePrefix, type, language, project }) => {
		try {
			const results = await index.search(query, {
				limit,
				filePrefix,
				type,
				language,
				project,
			});

			if (results.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No results found." }],
				};
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

			return {
				content: [{ type: "text" as const, text }],
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text" as const, text: `Error: ${msg}` }],
				isError: true,
			};
		}
	},
);

server.tool(
	"list_other_indexed_projects",
	"List all indexed projects other than the current one. " +
		"Use this to discover what projects are available for cross-project search " +
		"via the `project` parameter on the search tool.",
	{},
	async () => {
		const others = getOtherProjects();

		if (others.length === 0) {
			return {
				content: [
					{
						type: "text" as const,
						text: "No other indexed projects found.",
					},
				],
			};
		}

		const lines = others.map((p) => {
			const parts = [p.root];
			if (p.remote) parts.push(`(${p.remote})`);
			return `- ${parts.join(" ")}`;
		});

		return {
			content: [
				{
					type: "text" as const,
					text: `Indexed projects:\n${lines.join("\n")}`,
				},
			],
		};
	},
);

// --- Watch for index state changes and update tool description ---

let wasIndexed = isCurrentProjectIndexed();
tryStartWatcher();

setInterval(() => {
	const nowIndexed = isCurrentProjectIndexed();
	if (nowIndexed !== wasIndexed) {
		wasIndexed = nowIndexed;
		searchTool.update({ description: buildSearchDescription() });

		// Start watcher if project just got indexed
		if (nowIndexed) {
			tryStartWatcher();
		}
	}
}, 10_000);

// --- Cleanup on exit ---

process.on("exit", () => {
	stopWatcher?.();
});
process.on("SIGINT", () => {
	stopWatcher?.();
	process.exit(0);
});
process.on("SIGTERM", () => {
	stopWatcher?.();
	process.exit(0);
});

// --- Start ---

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	console.error("lmgrep MCP server error:", err);
	process.exit(1);
});
