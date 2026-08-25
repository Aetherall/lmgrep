import type { Command } from "commander";
import { CliOptions } from "../CliOptions.js";
import type { CommandContext, GlobalOptions } from "../CommandContext.js";

interface IndexOptions extends GlobalOptions {
	reset?: boolean;
	verbose?: boolean;
	since?: string;
	force?: boolean;
	dry?: boolean;
}

/** `lmgrep index` — build or update the index for the working directory. */
export class IndexCommand {
	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		program
			.command("index")
			.description("Index the current directory for semantic search")
			.option("-r, --reset", "Reset and rebuild the entire index")
			.option("-v, --verbose", "Show file-by-file progress")
			.option(
				"-s, --since <duration>",
				"Only consider files modified within duration (e.g. 10m, 2h, 1d)",
			)
			.option(
				"-f, --force",
				"Force re-embed even if file hash unchanged (use with --since)",
			)
			.option(
				"-d, --dry",
				"Show what would be indexed without actually doing it",
			)
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action((options: IndexOptions) => this.run(options));
	}

	private async run(options: IndexOptions): Promise<void> {
		await this.context.withLmgrep(options, (lmgrep) =>
			lmgrep.build({
				reset: options.reset,
				verbose: options.verbose,
				since: options.since,
				force: options.force,
				dry: options.dry,
				// A foreground command the user is watching, so it is the right
				// place to pay the one-time ANN training cost.
				createIndex: true,
			}),
		);
	}
}
