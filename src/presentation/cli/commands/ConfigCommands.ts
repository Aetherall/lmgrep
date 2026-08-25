import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import type { LmgrepConfig } from "../../../domain/config/LmgrepConfig.js";
import { ModelIdentity } from "../../../domain/project/ModelIdentity.js";
import { EmbeddingPrefixes } from "../../../infrastructure/ai/EmbeddingPrefixes.js";
import { LocalRuntimeDetector } from "../../../infrastructure/ai/LocalRuntimeDetector.js";
import type { DetectedRuntime } from "../../../infrastructure/ai/ModelRuntime.js";
import { ConfigLoader } from "../../../infrastructure/fs/ConfigLoader.js";
import type { CommandContext } from "../CommandContext.js";
import { ConfigTemplate } from "../ConfigTemplate.js";

/**
 * `init` and `config` — getting a working configuration.
 *
 * Both write exactly one file: the machine config. Which model to embed with
 * describes this computer, not any repository, so there is one place it can
 * live and one file to edit when it is wrong.
 *
 * `init` no longer has to reason about which model an existing index was built
 * with. Indexes are stored per model, so choosing a different one selects a
 * different database rather than corrupting the meaning of an existing one —
 * an entire class of "you must pick a compatible model" logic that stopped
 * being necessary the moment the storage layout changed.
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
			.description("Detect your local models and write the machine config")
			.option("--force", "Overwrite the existing config")
			.action((options: { force?: boolean }) => this.runInit(options));
	}

	private async runInit(options: { force?: boolean }): Promise<void> {
		const { renderer } = this.context;
		const loader = new ConfigLoader();
		const configPath = loader.globalConfigPath();

		if (existsSync(configPath) && !options.force) {
			renderer.error(
				`Config already exists at ${configPath}. Use --force to re-detect, or \`lmgrep config\` to edit.`,
			);
			process.exitCode = 1;
			return;
		}

		// The config already at this path is an explicit prior choice.
		const previous = loader.readFile(configPath);

		const runtime = await new LocalRuntimeDetector().detectBest();
		if (!runtime) {
			this.reportNoRuntime();
			this.write(configPath, ConfigTemplate.render());
			renderer.line(`\nWrote ${configPath} (set a model before indexing)`);
			return;
		}

		renderer.line(`Found ${runtime.label}.`);
		const model =
			this.keepConfigured(runtime, previous?.model, "embedding") ??
			this.selectEmbeddingModel(runtime);
		const chatModel =
			this.keepConfigured(runtime, previous?.chatModel, "chat") ??
			this.selectChatModel(runtime);

		this.write(
			configPath,
			ConfigTemplate.render({
				model: model ? `${runtime.providerId}:${model}` : undefined,
				baseURL: model ? runtime.baseURL : undefined,
				providerPackage: model ? runtime.providerPackage : undefined,
				local: model ? true : undefined,
				chatModel: chatModel ? `${runtime.providerId}:${chatModel}` : undefined,
				prefixes: this.prefixesFor(model, previous),
				// Carried through rather than regenerated: this is tuning the
				// user chose, and init has no better answer than they did.
				batchSize: previous?.batchSize,
				maxTokens: previous?.maxTokens,
				dimensions: previous?.dimensions,
			}),
		);
		renderer.line(`Wrote ${configPath}`);
	}

	/**
	 * Keep the model the config already names, when the runtime still offers it.
	 *
	 * Detection reads whatever the server lists first or happens to have
	 * loaded, and both move — LM Studio reorders by recency and unloads when
	 * idle. A model written in the config is a decision; re-deriving one from
	 * volatile state would silently swap it.
	 */
	private keepConfigured(
		runtime: DetectedRuntime,
		configured: string | undefined,
		kind: "embedding" | "chat",
	): string | undefined {
		if (!configured) return undefined;

		const reference = ModelIdentity.of(configured);
		if (reference.provider !== runtime.providerId) return undefined;

		if (!runtime.models.some((m) => m.id === reference.family)) {
			this.context.renderer.line(
				`Configured ${kind} model "${reference.family}" is no longer available in ${runtime.label}.`,
			);
			return undefined;
		}

		this.context.renderer.line(
			`Keeping configured ${kind} model: ${reference.family}`,
		);
		return reference.family;
	}

	/**
	 * Prefixes to write: the ones already configured win, since they may be
	 * hand-tuned for a model this table knows nothing about, and an empty
	 * document prefix is a deliberate setting rather than an absent one.
	 */
	private prefixesFor(
		model: string | undefined,
		previous: Partial<LmgrepConfig> | undefined,
	): { query: string; document: string; family?: string } | undefined {
		if (previous?.queryPrefix !== undefined) {
			return {
				query: previous.queryPrefix,
				document: previous.documentPrefix ?? "",
			};
		}
		return model ? EmbeddingPrefixes.forModel(model) : undefined;
	}

	private selectEmbeddingModel(runtime: DetectedRuntime): string | undefined {
		const { renderer } = this.context;
		const embedders = LocalRuntimeDetector.embeddingModels(runtime);
		// Runtimes that do not type their models still list them; treat the
		// untyped ones as last-resort candidates.
		const candidates = [
			...embedders,
			...LocalRuntimeDetector.untypedModels(runtime),
		];

		const picked = embedders[0] ?? candidates[0];
		if (!picked) {
			renderer.line(`\nNo models available in ${runtime.label}.`);
			renderer.line(
				"Install an embedding model (e.g. nomic-embed-text), then run `lmgrep init` again.",
			);
			return undefined;
		}

		renderer.line(
			`Using embedding model: ${picked.id}${picked.loaded ? " (loaded)" : ""}`,
		);
		if (picked.kind !== "embedding") {
			renderer.line(
				"  (this model's type could not be confirmed — check it is an embedder)",
			);
		}
		this.reportAlternatives(candidates, picked.id);
		const prefixes = EmbeddingPrefixes.forModel(picked.id);
		if (prefixes) {
			renderer.line(
				`  ${prefixes.family} is asymmetric — writing its required prefixes`,
			);
		}
		return picked.id;
	}

	/**
	 * Pick a model for `ask`, but only one the runtime typed as a chat model.
	 * Guessing here surfaces as a confusing failure much later, at answer time.
	 */
	private selectChatModel(runtime: DetectedRuntime): string | undefined {
		const [picked] = LocalRuntimeDetector.chatModels(runtime);
		if (!picked) return undefined;
		this.context.renderer.line(
			`Using chat model for \`ask\`: ${picked.id}${picked.loaded ? " (loaded)" : ""}`,
		);
		return picked.id;
	}

	/**
	 * Name the models not chosen.
	 *
	 * The pick is a guess whenever nothing is loaded, and switching means
	 * editing one config line — but only if the user knows what else was
	 * there. Switching is now cheap and reversible, since each model keeps its
	 * own index, but it still costs a re-embed the first time.
	 */
	private reportAlternatives(
		candidates: readonly { id: string }[],
		chosen: string,
	): void {
		const others = candidates.filter((m) => m.id !== chosen);
		if (others.length === 0) return;
		this.context.renderer.line(
			`  Also available: ${others.map((m) => m.id).join(", ")}`,
		);
		this.context.renderer.line("  Change `model` in the config to switch.");
	}

	private reportNoRuntime(): void {
		const { renderer } = this.context;
		renderer.line("No local embedding server detected.\n");
		renderer.line("Start one of:");
		renderer.line("  Ollama     curl -fsSL https://ollama.com/install.sh | sh");
		renderer.line("  LM Studio  https://lmstudio.ai — enable the local server");
		renderer.line("");
		renderer.line(
			"Then run `lmgrep init` again to auto-configure, or edit the config by hand.",
		);
	}

	private write(configPath: string, contents: string): void {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, contents);
	}

	private registerConfig(program: Command): void {
		program
			.command("config")
			.description("Open the machine config in your editor")
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
