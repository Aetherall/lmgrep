import type { Command } from "commander";
import { CliOptions } from "../CliOptions.js";
import type { CommandContext, GlobalOptions } from "../CommandContext.js";
import { Renderer } from "../Renderer.js";

interface AskOptions extends GlobalOptions {
	json?: boolean;
	quiet?: boolean;
}

/**
 * `lmgrep ask` — a synthesized, cited answer.
 *
 * The live trace goes to stderr and the answer to stdout, so the command stays
 * pipeable while still showing progress on a run that can take minutes.
 */
export class AskCommand {
	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		program
			.command("ask <question>")
			.description(
				"Answer a question with a local agentic research loop (search + read + synthesize). Requires `chatModel` in config.",
			)
			.option(
				"--json",
				"Output the full result (answer, sources, trace) as JSON",
			)
			.option("--quiet", "Suppress the live research trace on stderr")
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action((question: string, options: AskOptions) =>
				this.run(question, options),
			);
	}

	private async run(question: string, options: AskOptions): Promise<void> {
		const { renderer } = this.context;
		await this.context.guarded(async () => {
			await this.context.withLmgrep(options, async (lmgrep) => {
				const result = await lmgrep.ask(
					question,
					options.quiet
						? undefined
						: (entry) =>
								process.stderr.write(`${Renderer.formatTrace(entry)}\n`),
				);

				if (options.json) {
					renderer.json(result);
					return;
				}

				if (!options.quiet) process.stderr.write("\n");
				renderer.line(result.answer);

				if (result.sources.length > 0) {
					renderer.line("\nSources:");
					for (const s of result.sources) {
						renderer.line(`  [${s.n}] ${s.path}:${s.startLine}-${s.endLine}`);
					}
				}

				const seconds = (result.elapsedMs / 1000).toFixed(1);
				const degraded = result.degraded
					? " (degraded: synthesis unavailable)"
					: "";
				process.stderr.write(
					`\n(${result.steps} steps, ${seconds}s)${degraded}\n`,
				);
			});
		});
	}
}
