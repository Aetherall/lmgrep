import type { Command } from "commander";
import type { FacetView } from "../../../application/faceting/FacetNavigator.js";
import { CliOptions } from "../CliOptions.js";
import {
	type CommandContext,
	CommandContext as Ctx,
	type GlobalOptions,
} from "../CommandContext.js";

interface ViewOptions extends GlobalOptions {
	json?: boolean;
	verbose?: boolean;
}

/**
 * `lmgrep facet` — explore what kinds of code match a query.
 *
 * The subcommands form a navigation loop: `search` opens a session and prints
 * its id, then `list`, `show` and `refine` all address nodes by path within it.
 */
export class FacetCommand {
	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		const facet = program
			.command("facet")
			.description("Cluster search results into semantic facets");

		this.registerIndex(facet);
		this.registerSearch(facet);
		this.registerList(facet);
		this.registerShow(facet);
		this.registerRefine(facet);
	}

	private registerIndex(facet: Command): void {
		facet
			.command("index")
			.description("Build the vocab table used for cluster labeling")
			.option("--reset", "Drop and rebuild the vocab table")
			.option(
				"--min-df <n>",
				"Min document frequency for a term to be embedded",
				"10",
			)
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action(
				async (options: GlobalOptions & { reset?: boolean; minDf: string }) => {
					await this.context.withLmgrep(options, async (lmgrep) => {
						const result = await lmgrep.facetIndex({
							reset: options.reset,
							minDf: Ctx.integer(options.minDf, 10),
						});
						this.context.renderer.line(
							`Vocab: +${result.added} new terms (${result.total} total).`,
						);
					});
				},
			);
	}

	private registerSearch(facet: Command): void {
		facet
			.command("search <query>")
			.description("Run semantic search and print root facets + session id")
			.option("-m, --limit <n>", "Max results to cluster", "25")
			.option("-k, --k <n>", "Number of facets", "5")
			.option(
				"--file-prefix <prefix>",
				"Only search files matching this path prefix",
			)
			.option("--json", "Output as JSON")
			.option("-v, --verbose", "Show top vocab candidates per cluster")
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action(
				async (
					query: string,
					options: ViewOptions & {
						limit: string;
						k: string;
						filePrefix?: string;
					},
				) => {
					await this.context.withLmgrep(options, async (lmgrep) => {
						const view = await lmgrep.facetSearch(query, {
							limit: Ctx.integer(options.limit, 25),
							k: Ctx.integer(options.k, 5),
							filePrefix: options.filePrefix,
						});
						if (options.json) {
							this.context.renderer.json(view);
							return;
						}
						if (view.labels.length === 0) {
							this.context.renderer.line("No results found.");
							return;
						}
						// The session id leads, because every follow-up command
						// needs it.
						this.context.renderer.line(view.sessionId);
						this.renderView(view, options);
					});
				},
			);
	}

	private registerList(facet: Command): void {
		facet
			.command("list <path>")
			.description("Print the facet list at a node (e.g. kx3 or kx3/token)")
			.option("--json", "Output as JSON")
			.option("-v, --verbose", "Show top vocab candidates per cluster")
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action(async (path: string, options: ViewOptions) => {
				await this.context.guarded(async () => {
					await this.context.withLmgrep(options, async (lmgrep) => {
						const view = await lmgrep.facetList(path);
						if (options.json) {
							this.context.renderer.json(view);
							return;
						}
						this.renderView(view, options);
					});
				});
			});
	}

	private registerShow(facet: Command): void {
		facet
			.command("show <path>")
			.description("Print the result chunks at a node")
			.option("--json", "Output as JSON")
			.option("--compact", "Show file paths only")
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action(
				async (
					path: string,
					options: GlobalOptions & { json?: boolean; compact?: boolean },
				) => {
					await this.context.guarded(async () => {
						await this.context.withLmgrep(options, async (lmgrep) => {
							const contents = await lmgrep.facetShow(path);
							const { renderer } = this.context;
							if (options.json) {
								renderer.json(contents);
							} else if (contents.results.length === 0) {
								renderer.line("(empty)");
							} else if (options.compact) {
								renderer.hitPaths(contents.results);
							} else {
								renderer.hits(contents.results);
							}
						});
					});
				},
			);
	}

	private registerRefine(facet: Command): void {
		facet
			.command("refine <path>")
			.description("Compute child facets for the pool at a node")
			.option("-k, --k <n>", "Number of facets", "5")
			.option("--json", "Output as JSON")
			.option("-v, --verbose", "Show top vocab candidates per cluster")
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action(async (path: string, options: ViewOptions & { k: string }) => {
				await this.context.guarded(async () => {
					await this.context.withLmgrep(options, async (lmgrep) => {
						const view = await lmgrep.facetRefine(path, {
							k: Ctx.integer(options.k, 5),
						});
						if (options.json) {
							this.context.renderer.json(view);
							return;
						}
						if (view.labels.length === 0) {
							this.context.renderer.line("(nothing to refine)");
							return;
						}
						this.renderView(view, options);
					});
				});
			});
	}

	private renderView(view: FacetView, options: ViewOptions): void {
		if (options.verbose) this.context.renderer.facetDetail(view);
		else this.context.renderer.facetLabels(view);
	}
}
