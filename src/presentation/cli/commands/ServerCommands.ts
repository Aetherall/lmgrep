import type { Command } from "commander";
import { CliOptions } from "../CliOptions.js";
import type { CommandContext, GlobalOptions } from "../CommandContext.js";

/**
 * `serve` and `mcp` — the two long-running modes.
 *
 * Both keep the process alive deliberately: `serve` watches for changes, and
 * `mcp` speaks the protocol over stdio until its client disconnects.
 */
export class ServerCommands {
	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		CliOptions.target(
			program
				.command("serve")
				.description("Watch this project and re-index as files change"),
		).action(async (options: GlobalOptions) => {
			const lmgrep = await this.context.open(options);
			const stop = lmgrep.watch();
			// Deliberately not closed: the watcher owns this process until
			// it is signalled.
			const shutdown = (): void => {
				stop();
				void lmgrep.close().finally(() => process.exit(0));
			};
			process.on("SIGINT", shutdown);
			process.on("SIGTERM", shutdown);
		});

		CliOptions.target(
			program
				.command("mcp")
				.description("Start the MCP server (stdio transport)"),
		).action(async (options: GlobalOptions) => {
			// The entry point reads its target from the environment, so it can
			// be launched either as `lmgrep mcp` or as `lmgrep-mcp`.
			const target = options.in?.[0];
			if (target) process.env.LMGREP_DATABASE = target;
			await import("../../../mcp.js");
		});
	}
}
