#!/usr/bin/env node
process.title = "lmgrep-mcp";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createLmgrepCore } from "./lib/search-tool.js";

const core = await createLmgrepCore({ cwd: process.cwd() });

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
	"list_other_indexed_projects",
	core.listProjectsDescription,
	{},
	async () => {
		const result = await core.executeListProjects();
		return { content: [{ type: "text" as const, text: result.text }] };
	},
);

core.onHealthChange(() => {
	searchTool.update({ description: core.buildSearchDescription() });
});

core.startHealthLoop();

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
