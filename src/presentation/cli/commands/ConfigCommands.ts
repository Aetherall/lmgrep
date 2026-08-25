import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import type { LmgrepConfig } from "../../../domain/config/LmgrepConfig.js";
import { ModelIdentity } from "../../../domain/project/ModelIdentity.js";
import { ProjectLocator } from "../../../domain/project/ProjectLocator.js";
import { EmbeddingPrefixes } from "../../../infrastructure/ai/EmbeddingPrefixes.js";
import { LocalRuntimeDetector } from "../../../infrastructure/ai/LocalRuntimeDetector.js";
import type { DetectedRuntime } from "../../../infrastructure/ai/ModelRuntime.js";
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

		// The config already at this path is an explicit prior choice; an index
		// built from it is a harder constraint still.
		const previous = loader.readFile(configPath);
		const existing = this.existingIndexMetadata(cwd);
		const indexFamily = existing?.model
			? ModelIdentity.of(existing.model).family
			: undefined;

		const runtime = await new LocalRuntimeDetector().detectBest();
		if (!runtime) {
			this.reportNoRuntime(existing, indexFamily);
			this.write(configPath, ConfigTemplate.render());
			renderer.line(`\nWrote ${configPath} (edit model before indexing)`);
			return;
		}

		renderer.line(`Found ${runtime.label}.`);
		const model =
			this.keepConfiguredModel(runtime, previous) ??
			this.selectEmbeddingModel(runtime, existing, indexFamily);
		const chatModel = model
			? (this.keepConfiguredChatModel(runtime, previous) ??
				this.selectChatModel(runtime))
			: undefined;

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
	 * volatile state would silently swap it, and re-indexing under a different
	 * model is not a small mistake.
	 */
	private keepConfiguredModel(
		runtime: DetectedRuntime,
		previous: Partial<LmgrepConfig> | undefined,
	): string | undefined {
		const configured = previous?.model;
		if (!configured) return undefined;

		const reference = ModelIdentity.of(configured);
		if (reference.provider !== runtime.providerId) return undefined;

		const available = runtime.models.some((m) => m.id === reference.family);
		if (!available) {
			this.context.renderer.line(
				`Configured model "${reference.family}" is no longer available in ${runtime.label}.`,
			);
			return undefined;
		}

		this.context.renderer.line(
			`Keeping configured embedding model: ${reference.family}`,
		);
		return reference.family;
	}

	/** Same reasoning as {@link keepConfiguredModel}, for `ask`. */
	private keepConfiguredChatModel(
		runtime: DetectedRuntime,
		previous: Partial<LmgrepConfig> | undefined,
	): string | undefined {
		const configured = previous?.chatModel;
		if (!configured) return undefined;
		const reference = ModelIdentity.of(configured);
		if (reference.provider !== runtime.providerId) return undefined;
		if (!runtime.models.some((m) => m.id === reference.family)) {
			return undefined;
		}
		this.context.renderer.line(
			`Keeping configured chat model: ${reference.family}`,
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

	/**
	 * Choose an embedding model, respecting an existing index's family above
	 * all else — a mismatch produces incomparable vectors, not merely worse
	 * results, so it is better to configure nothing than the wrong thing.
	 */
	private selectEmbeddingModel(
		runtime: DetectedRuntime,
		existing: { model?: string; dimensions?: number } | undefined,
		indexFamily: string | undefined,
	): string | undefined {
		const { renderer } = this.context;
		const embedders = LocalRuntimeDetector.embeddingModels(runtime);
		// Runtimes that do not type their models still list them; treat the
		// untyped ones as last-resort candidates.
		const candidates = [
			...embedders,
			...LocalRuntimeDetector.untypedModels(runtime),
		];

		if (indexFamily) {
			renderer.line(
				`Index built with "${existing?.model}" (${indexFamily}${existing?.dimensions ? `, ${existing.dimensions} dims` : ""})`,
			);
			const compatible = candidates.find(
				(m) =>
					ModelIdentity.of(`${runtime.providerId}:${m.id}`).family ===
					indexFamily,
			);
			if (compatible) {
				renderer.line(`Found compatible model: ${compatible.id}`);
				return compatible.id;
			}
			renderer.line(
				`\nNo compatible model available. You need one from the "${indexFamily}" family.`,
			);
			renderer.line(
				`Install it in ${runtime.label}, then run \`lmgrep init\` again.`,
			);
			return undefined;
		}

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
	 * there. Silently choosing one of five is how you end up indexing a whole
	 * repository with the wrong model.
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

	private existingIndexMetadata(cwd: string) {
		const state = new StateDirectory();
		const locator = new ProjectLocator(new GitClient(), state);
		const databasePath = locator.databasePathFor(cwd);
		return existsSync(databasePath)
			? new ProjectMetadataStore(state).read(databasePath)
			: undefined;
	}

	private reportNoRuntime(
		existing: { model?: string; dimensions?: number } | undefined,
		indexFamily: string | undefined,
	): void {
		const { renderer } = this.context;
		renderer.line("No local embedding server detected.\n");
		renderer.line("Start one of:");
		renderer.line("  Ollama     curl -fsSL https://ollama.com/install.sh | sh");
		renderer.line("  LM Studio  https://lmstudio.ai — enable the local server");
		renderer.line("");
		if (indexFamily && existing) {
			renderer.line(
				`This index was built with "${existing.model}" (${existing.dimensions} dims).`,
			);
			renderer.line("Load a compatible model, then run `lmgrep init` again.");
		} else {
			renderer.line(
				"Then run `lmgrep init` again to auto-configure, or edit the config by hand.",
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
