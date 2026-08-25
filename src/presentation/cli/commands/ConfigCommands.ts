import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { ModelIdentity } from "../../../domain/project/ModelIdentity.js";
import { ProjectLocator } from "../../../domain/project/ProjectLocator.js";
import { OllamaProbe } from "../../../infrastructure/ai/OllamaProbe.js";
import { ConfigLoader } from "../../../infrastructure/fs/ConfigLoader.js";
import { ProjectMetadataStore } from "../../../infrastructure/fs/ProjectMetadataStore.js";
import { StateDirectory } from "../../../infrastructure/fs/StateDirectory.js";
import { GitClient } from "../../../infrastructure/git/GitClient.js";
import type { CommandContext } from "../CommandContext.js";
import { ConfigTemplate } from "../ConfigTemplate.js";

/**
 * `init` and `config` — getting a working configuration.
 *
 * `init` is deliberately opinionated: it detects Ollama, and when an index
 * already exists it will only propose a model from the same family, because
 * configuring an incompatible one silently breaks every future search.
 */
export class ConfigCommands {
	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		this.registerInit(program);
		this.registerConfig(program);
	}

	private registerInit(program: Command): void {
		program
			.command("init")
			.description("Detect your embedding setup and create config")
			.option("--force", "Overwrite existing config")
			.option(
				"--local",
				"Write a project-local .lmgrep.yml instead of the global config",
			)
			.action((options: { force?: boolean; local?: boolean }) =>
				this.runInit(options),
			);
	}

	private async runInit(options: {
		force?: boolean;
		local?: boolean;
	}): Promise<void> {
		const { renderer } = this.context;
		const cwd = this.context.cwd;
		const loader = new ConfigLoader();
		const configPath = options.local
			? join(cwd, ".lmgrep.yml")
			: loader.globalConfigPath();

		if (existsSync(configPath) && !options.force) {
			renderer.error(
				`Config already exists at ${configPath}. Use --force to overwrite.`,
			);
			process.exitCode = 1;
			return;
		}

		const state = new StateDirectory();
		const locator = new ProjectLocator(new GitClient(), state);
		const metadata = new ProjectMetadataStore(state);
		const databasePath = locator.databasePathFor(cwd);
		const existing = existsSync(databasePath)
			? metadata.read(databasePath)
			: undefined;
		const indexFamily = existing?.model
			? ModelIdentity.of(existing.model).family
			: undefined;

		const ollama = await new OllamaProbe().detect();
		if (!ollama.running) {
			this.reportMissingOllama(existing, indexFamily);
			this.write(configPath, ConfigTemplate.render());
			renderer.line(`\nWrote ${configPath} (edit model before indexing)`);
			return;
		}

		renderer.line("Found Ollama.");
		const model = this.selectModel(ollama.models, existing, indexFamily);

		this.write(
			configPath,
			ConfigTemplate.render({
				model: model ? `ollama:${model}` : undefined,
				baseURL: model ? OllamaProbe.BASE_URL : undefined,
			}),
		);
		renderer.line(`Wrote ${configPath}`);
	}

	/**
	 * Choose a model, respecting an existing index's family above all else —
	 * a mismatch produces incomparable vectors, not merely worse results.
	 */
	private selectModel(
		available: string[],
		existing: { model?: string; dimensions?: number } | undefined,
		indexFamily: string | undefined,
	): string | undefined {
		const { renderer } = this.context;

		if (indexFamily && existing?.dimensions) {
			renderer.line(
				`Index built with "${existing.model}" (${indexFamily}, ${existing.dimensions} dims)`,
			);
			const compatible = available.find(
				(m) => ModelIdentity.of(`ollama:${m}`).family === indexFamily,
			);
			if (compatible) {
				renderer.line(`Found compatible model: ${compatible}`);
				return compatible;
			}
			renderer.line(
				`\nNo compatible model found locally. You need a model from the "${indexFamily}" family.`,
			);
			renderer.line("Pull one with:");
			renderer.line(`  ollama pull ${indexFamily}\n`);
			renderer.line("Then run `lmgrep init` again to auto-configure.");
			return undefined;
		}

		if (indexFamily) return undefined;

		const picked = OllamaProbe.pickEmbeddingModel(available);
		if (picked) {
			renderer.line(`Using model: ${picked}`);
			return picked;
		}
		renderer.line("\nNo models found. Pull an embedding model:");
		renderer.line("  ollama pull nomic-embed-text\n");
		renderer.line("Then run `lmgrep init` again.");
		return undefined;
	}

	private reportMissingOllama(
		existing: { model?: string; dimensions?: number } | undefined,
		indexFamily: string | undefined,
	): void {
		const { renderer } = this.context;
		renderer.line("Ollama not detected.\n");
		renderer.line("Install Ollama:");
		renderer.line("  curl -fsSL https://ollama.com/install.sh | sh\n");
		if (indexFamily && existing) {
			renderer.line(
				`This index was built with "${existing.model}" (${existing.dimensions} dims).`,
			);
			renderer.line(
				"After installing Ollama, pull a compatible model and run `lmgrep init` again.",
			);
		} else {
			renderer.line(
				"After installing, run `lmgrep init` again to auto-configure.",
			);
		}
	}

	private write(configPath: string, contents: string): void {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, contents);
	}

	private registerConfig(program: Command): void {
		program
			.command("config")
			.description("Open the global config file in your editor")
			.action(() => {
				const { renderer } = this.context;
				const configPath = new ConfigLoader().globalConfigPath();
				if (!existsSync(configPath)) {
					renderer.error(
						`No config found at ${configPath}. Run \`lmgrep init\` first.`,
					);
					process.exitCode = 1;
					return;
				}

				const editorCommand = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
				renderer.line(`Opening ${configPath}`);

				// $EDITOR may carry flags ("code -w"), so split those off — but
				// pass the path as its own argv entry, or a directory with
				// spaces (macOS "Application Support") gets re-split.
				const [editor, ...args] = editorCommand.trim().split(/\s+/);
				const result = spawnSync(editor, [...args, configPath], {
					stdio: "inherit",
				});
				if (result.error || (result.status != null && result.status !== 0)) {
					renderer.error(
						`Could not open editor "${editorCommand}". Set $EDITOR or $VISUAL.`,
					);
					process.exitCode = 1;
				}
			});
	}
}
