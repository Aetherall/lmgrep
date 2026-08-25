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
		program
			.command("serve")
			.description("Watch the current directory and re-index on changes")
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action(async (options: GlobalOptions) => {
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

		program
			.command("mcp")
			.description("Start the MCP server (stdio transport)")
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action(async (options: GlobalOptions) => {
				// The entry point reads its target from the environment, so it
				// can be launched either as `lmgrep mcp` or as `lmgrep-mcp`.
				if (options.database) {
					process.env.LMGREP_DATABASE = options.database;
				}
				await import("../../../mcp.js");
			});
	}
}
