import type { Command } from "commander";
import { CliOptions } from "../CliOptions.js";
import type { CommandContext, GlobalOptions } from "../CommandContext.js";
import { CommandContext as Ctx } from "../CommandContext.js";

interface SearchOptions extends GlobalOptions {
	limit: string;
	compact?: boolean;
	json?: boolean;
	under?: string;
	language?: string;
}

/**
 * `lmgrep search` — the primary read path, and what a bare `lmgrep <query>`
 * runs.
 *
 * The options here are the ones a person can answer from what they already
 * know: how many results, where to look, which languages. Three that used to
 * exist are gone because they could only be set by trial and error —
 * `--min-score` needs the score distribution of your embedding model,
 * `--type` needs tree-sitter's per-language node names, and `--not` doubled
 * the cost of a query to express something a better query expresses anyway.
 */
export class SearchCommand {
	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		CliOptions.target(
			program
				.command("search <query...>")
				.description("Search the codebase using natural language")
				.option("-m, --limit <n>", "Max results", "25")
				.option("--under <path>", "Only search files under this path")
				.option(
					"--language <exts>",
					"Only search these file extensions (comma-separated, e.g. .ts,.py)",
				)
				.option("--compact", "Print matching file paths only")
				.option("--json", "Print results as JSON"),
		).action((query: string[], options: SearchOptions) =>
			this.run(query.join(" "), options),
		);
	}

	private async run(query: string, options: SearchOptions): Promise<void> {
		const { across } = Ctx.targets(options);
		await this.context.withLmgrep(options, async (lmgrep) => {
			const hits = await lmgrep.search(query, {
				limit: Ctx.integer(options.limit, 25),
				filePrefix: options.under,
				language: Ctx.list(options.language),
				across: across.length > 0 ? across : undefined,
			});

			const { renderer } = this.context;
			if (options.json) {
				renderer.json(hits.toArray());
				return;
			}
			if (hits.isEmpty) {
				renderer.line("No results found.");
				return;
			}
			if (options.compact) {
				renderer.hitPaths(hits.toArray());
				return;
			}
			renderer.hits(hits.toArray());
		});
	}
}
