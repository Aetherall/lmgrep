import { McpServer as Server } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { LmgrepCore } from "./LmgrepCore.js";

/**
 * Exposes lmgrep over MCP.
 *
 * The search tool's description is re-published whenever health changes, so an
 * agent's next turn sees an accurate account of whether search works — that
 * live update is the reason this server holds a health monitor at all.
 */
export class LmgrepMcpServer {
	private readonly server: Server;

	constructor(private readonly core: LmgrepCore) {
		this.server = new Server({ name: "lmgrep", version: "0.1.0" });
	}

	async serve(): Promise<void> {
		const search = this.registerSearch();
		this.registerListProjects();
		if (this.core.askAvailable) this.registerAsk();

		this.core.onHealthChange(() => {
			search.update({ description: this.core.buildSearchDescription() });
		});
		this.core.start();

		await this.server.connect(new StdioServerTransport());
	}

	private registerSearch() {
		const params = this.core.searchParams;
		return this.server.tool(
			"search",
			this.core.buildSearchDescription(),
			{
				query: z.string().describe(params.query.description),
				limit: z
					.number()
					.optional()
					.default(params.limit.default)
					.describe(params.limit.description),
				filePrefix: z
					.string()
					.optional()
					.describe(params.filePrefix.description),
				type: z.array(z.string()).optional().describe(params.type.description),
				language: z
					.array(z.string())
					.optional()
					.describe(params.language.description),
				project: z.string().optional().describe(params.project.description),
			},
			async (args) => this.toContent(await this.core.executeSearch(args)),
		);
	}

	private registerListProjects() {
		return this.server.tool(
			"list_other_indexed_projects",
			this.core.listProjectsDescription,
			{},
			async () => this.toContent(await this.core.executeListProjects()),
		);
	}

	private registerAsk() {
		return this.server.tool(
			"ask",
			this.core.askDescription,
			{ question: z.string().describe(this.core.askParam.description) },
			async (args) => this.toContent(await this.core.executeAsk(args)),
		);
	}

	private toContent(result: { text: string; isError?: boolean }) {
		return {
			content: [{ type: "text" as const, text: result.text }],
			...(result.isError ? { isError: true } : {}),
		};
	}
}
