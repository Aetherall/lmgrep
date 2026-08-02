#!/usr/bin/env node
process.title = "lmgrep-mcp";

// Must come first — sets TOKIO/RAYON/UV thread caps before LanceDB native
// binding initializes its runtime.
import "./lib/native-tuning.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createLmgrepCore } from "./lib/search-tool.js";

const core = await createLmgrepCore({
	cwd: process.cwd(),
	database: process.env.LMGREP_DATABASE || undefined,
});

const server = new McpServer({
	name: "lmgrep",
	version: "0.1.0",
});

const searchTool = server.tool(
	"search",
	core.buildSearchDescription(),
	{
		query: z.string().describe(core.searchParams.query.description),
		limit: z
			.number()
			.optional()
			.default(core.searchParams.limit.default)
			.describe(core.searchParams.limit.description),
		filePrefix: z
			.string()
			.optional()
			.describe(core.searchParams.filePrefix.description),
		type: z
			.array(z.string())
			.optional()
			.describe(core.searchParams.type.description),
		language: z
			.array(z.string())
			.optional()
			.describe(core.searchParams.language.description),
		project: z
			.string()
			.optional()
			.describe(core.searchParams.project.description),
	},
	async (args) => {
		const result = await core.executeSearch(args);
		return {
			content: [{ type: "text" as const, text: result.text }],
			...(result.isError ? { isError: true } : {}),
		};
	},
);

server.tool(
	"facet",
	core.facetDescription,
	{
		query: z.string().describe(core.facetParam.description),
	},
	async (args) => {
		const result = await core.executeFacet(args);
		return {
			content: [{ type: "text" as const, text: result.text }],
			...(result.isError ? { isError: true } : {}),
		};
	},
);

server.tool(
	"list_other_indexed_projects",
	core.listProjectsDescription,
	{},
	async () => {
		const result = await core.executeListProjects();
		return { content: [{ type: "text" as const, text: result.text }] };
	},
);

// `ask` runs a local research loop — only registered when a chat model is
// configured, so agents never see a tool they can't use.
if (core.askAvailable) {
	server.tool(
		"ask",
		core.askDescription,
		{
			question: z.string().describe(core.askParam.description),
		},
		async (args) => {
			const result = await core.executeAsk(args);
			return {
				content: [{ type: "text" as const, text: result.text }],
				...(result.isError ? { isError: true } : {}),
			};
		},
	);
}

core.onHealthChange(() => {
	searchTool.update({ description: core.buildSearchDescription() });
});

core.start();

process.on("exit", () => {
	core.dispose().catch(() => {});
});
process.on("SIGINT", () => {
	core.dispose().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
	core.dispose().finally(() => process.exit(0));
});

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	console.error("lmgrep MCP server error:", err);
	process.exit(1);
});
