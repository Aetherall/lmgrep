import type { Command } from "commander";
import { CliOptions } from "../CliOptions.js";
import type { CommandContext, GlobalOptions } from "../CommandContext.js";
import { CommandContext as Ctx } from "../CommandContext.js";

interface SearchOptions extends GlobalOptions {
	limit: string;
	scores?: boolean;
	compact?: boolean;
	json?: boolean;
	minScore?: string;
	filePrefix?: string;
	not?: string;
	type?: string;
	language?: string;
	project?: string;
	across?: string;
}

/** `lmgrep search` — the primary read path. */
export class SearchCommand {
	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		program
			.command("search <query>")
			.description("Search the codebase using natural language")
			.option("-m, --limit <n>", "Max results", "25")
			.option("--scores", "Show relevance scores")
			.option("--compact", "Show file paths only")
			.option("--json", "Output results as JSON")
			.option("--min-score <n>", "Minimum score threshold")
			.option(
				"--file-prefix <prefix>",
				"Only search files matching this path prefix",
			)
			.option("--not <query>", "Exclude results similar to this query")
			.option(
				"--type <types>",
				"Only return chunks of these AST types (comma-separated)",
			)
			.option(
				"--language <langs>",
				"Only return chunks from files with these extensions (comma-separated, e.g. .ts,.py)",
			)
			.option("--project <path>", "Search a different project's index")
			.option(
				"--across <paths>",
				"Search multiple project indexes (comma-separated paths)",
			)
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action((query: string, options: SearchOptions) =>
				this.run(query, options),
			);
	}

	private async run(query: string, options: SearchOptions): Promise<void> {
		await this.context.withLmgrep(options, async (lmgrep) => {
			const hits = await lmgrep.search(query, {
				limit: Ctx.integer(options.limit, 25),
				filePrefix: options.filePrefix,
				not: options.not,
				minScore: Ctx.float(options.minScore),
				type: Ctx.list(options.type),
				language: Ctx.list(options.language),
				project: options.project,
				across: Ctx.list(options.across),
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
			renderer.hits(hits.toArray(), { scores: options.scores });
		});
	}
}
