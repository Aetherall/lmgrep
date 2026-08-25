import type { Command } from "commander";
import { CliOptions } from "../CliOptions.js";
import type { CommandContext, GlobalOptions } from "../CommandContext.js";

interface IndexOptions extends GlobalOptions {
	reset?: boolean;
	verbose?: boolean;
	since?: string;
	dry?: boolean;
}

/**
 * `lmgrep index` — adopt a project, and keep it current.
 *
 * This is the one moment a user consents to lmgrep reading a whole repository
 * and spending time embedding it, which is why it stays an explicit command
 * rather than something a search triggers. Everything that used to be a
 * separate chore afterwards — reconciling the manifest, dropping duplicate
 * rows, compacting fragments, training the vector index — happens here, at the
 * one moment someone is already waiting and watching.
 */
export class IndexCommand {
	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		CliOptions.target(
			program
				.command("index")
				.description("Index this project for semantic search")
				.option("-r, --reset", "Discard the index and rebuild from scratch")
				.option("-v, --verbose", "Show file-by-file progress")
				.option(
					"-s, --since <duration>",
					"Only consider files modified within duration (e.g. 10m, 2h, 1d)",
				)
				.option("-d, --dry", "Report what would be indexed, and stop"),
		).action((options: IndexOptions) => this.run(options));
	}

	private async run(options: IndexOptions): Promise<void> {
		await this.context.withLmgrep(options, async (lmgrep) => {
			// Said before the work starts, not after: embedding a repository
			// with a newly configured model can take a long time, and someone
			// who only meant to try a model out should get the chance to put
			// the old one back instead of watching it run.
			this.context.renderer.newModelNotice(lmgrep.alternatives.others());

			const result = await lmgrep.build({
				reset: options.reset,
				verbose: options.verbose,
				since: options.since,
				dry: options.dry,
				// A foreground command the user is watching, so it is the right
				// place to pay the one-time ANN training cost.
				createIndex: true,
			});

			if (options.dry) return;
			// Only after a run that changed something: deduplication reads
			// every row, and paying that on `lmgrep index` over an unchanged
			// repository would make the no-op case the slow one.
			if (result.succeeded > 0 || result.removed > 0) {
				this.context.renderer.maintenance(await lmgrep.tidy());
			}
			this.context.renderer.line(`\nIndex: ${lmgrep.location.path}`);
		});
	}
}
