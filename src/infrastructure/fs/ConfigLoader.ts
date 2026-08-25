import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { ConfigSource } from "../../domain/config/ConfigSource.js";
import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";

/**
 * Loads configuration from two kinds of file, split by what the settings
 * actually describe.
 *
 * **Machine settings** — which model to embed with, which to answer with,
 * where those servers listen — describe *this computer's* inference setup.
 * They live in one global file. They used to be settable per project too,
 * which was the single most confusing thing about lmgrep: the model determines
 * what a stored vector *means*, so a project file could silently point an
 * index at incompatible embeddings, and `status` would report an effective
 * model without saying which of three files produced it.
 *
 * **Project settings** — what to ignore, which extensions to index — describe
 * *this repository*, are worth committing, and mean the same thing on every
 * machine that checks it out.
 *
 * Machine keys found in a project file are reported and ignored rather than
 * applied. Wanting a different model for one project is a real thing to want;
 * it is now spelled as a different database (`--database`), because the model
 * is a property of an index rather than of a directory.
 */
export class ConfigLoader {
	/** Settings that describe this machine's inference setup. */
	private static readonly MACHINE_SCHEMA = z.object({
		model: z
			.string()
			.regex(
				/^.+:.+$/,
				'Model must be in "provider:model" format (e.g. "ollama:nomic-embed-text")',
			),
		provider: z.string().optional(),
		baseURL: z.string().url().optional(),
		local: z.boolean().optional(),
		batchSize: z.number().int().positive().default(100),
		dimensions: z.number().int().positive().optional(),
		queryPrefix: z.string().optional(),
		documentPrefix: z.string().optional(),
		maxTokens: z.number().int().positive().optional(),
		chatModel: z
			.string()
			.regex(
				/^.+:.+$/,
				'chatModel must be in "provider:model" format (e.g. "lmstudio:qwen/qwen3.5-9b")',
			)
			.optional(),
		chatProvider: z.string().optional(),
		chatBaseURL: z.string().url().optional(),
		chatMaxSteps: z.number().int().positive().optional(),
		chatTimeoutMs: z.number().int().positive().optional(),
	});

	/** Settings that describe a repository. */
	private static readonly PROJECT_SCHEMA = z.object({
		ignore: z.array(z.string()).optional(),
		extensions: z
			.object({
				include: z.array(z.string()).optional(),
				exclude: z.array(z.string()).optional(),
			})
			.optional(),
	});

	private static readonly FILE_NAME = "config.yml";
	private static readonly PROJECT_FILE_NAMES = [".lmgrep.yml", ".lmgrep.yaml"];
	private static readonly DEFAULTS = { batchSize: 100 };

	/** Populated by {@link load}: what was read, and what was ignored. */
	readonly sources: ConfigSource[] = [];
	readonly warnings: string[] = [];

	load(cwd: string): LmgrepConfig {
		const layers: Array<Partial<LmgrepConfig>> = [];

		// Home-level files are machine settings wherever they sit; the bare
		// ~/.lmgrep.yml predates the XDG path and is still honoured so an
		// upgrade does not silently unconfigure anyone.
		const legacy = this.readMachineFile(
			join(homedir(), ".lmgrep.yml"),
			"deprecated",
		);
		if (legacy) layers.push(legacy);

		const global = this.readMachineFile(this.globalConfigPath());
		if (global) layers.push(global);

		const project = this.readProjectFile(cwd);
		if (project) layers.push(project);

		if (layers.length === 0) {
			throw new Error(
				"No configuration found. Run `lmgrep init` to set up your embedding model.",
			);
		}

		return this.validate(
			Object.assign({ ...ConfigLoader.DEFAULTS }, ...layers),
		);
	}

	/**
	 * The XDG-compliant global config directory.
	 *   Linux:  $XDG_CONFIG_HOME/lmgrep  or  ~/.config/lmgrep
	 *   macOS:  ~/Library/Application Support/lmgrep
	 */
	configDirectory(): string {
		if (platform() === "darwin") {
			return join(homedir(), "Library", "Application Support", "lmgrep");
		}
		const xdg = process.env.XDG_CONFIG_HOME;
		return join(xdg || join(homedir(), ".config"), "lmgrep");
	}

	globalConfigPath(): string {
		return join(this.configDirectory(), ConfigLoader.FILE_NAME);
	}

	/** Path of the project file in `cwd`, whether or not it exists. */
	projectConfigPath(cwd: string): string {
		for (const name of ConfigLoader.PROJECT_FILE_NAMES) {
			if (existsSync(join(cwd, name))) return join(cwd, name);
		}
		return join(cwd, ConfigLoader.PROJECT_FILE_NAMES[0]);
	}

	/**
	 * Parse a single machine config file, ignoring the layering.
	 *
	 * `init` rewrites one specific file, so it needs that file's own contents —
	 * merging layers here would copy one file's settings into another.
	 */
	readFile(path: string): Partial<LmgrepConfig> | undefined {
		const raw = this.parseYaml(path);
		if (!raw) return undefined;
		return ConfigLoader.MACHINE_SCHEMA.partial().parse(
			this.pick(raw, ConfigLoader.machineKeys()),
		);
	}

	private readMachineFile(
		path: string,
		deprecated?: "deprecated",
	): Partial<LmgrepConfig> | undefined {
		const raw = this.parseYaml(path);
		if (!raw) return undefined;

		const projectKeys = ConfigLoader.projectKeys().filter((k) => k in raw);
		if (projectKeys.length > 0) {
			this.warnings.push(
				`${path}: ${projectKeys.join(", ")} ${projectKeys.length === 1 ? "is a project setting" : "are project settings"} — ` +
					"move to .lmgrep.yml in the repository it applies to.",
			);
		}

		const parsed = ConfigLoader.MACHINE_SCHEMA.partial().parse(
			this.pick(raw, ConfigLoader.machineKeys()),
		);
		// Deprecation is not warned about here: `lmgrep status` marks the
		// location in its provenance listing, which is where someone is
		// actually looking at their configuration. Printing it before every
		// search would be noise on the one path that must stay quiet.
		this.sources.push({
			path,
			scope: "machine",
			keys: Object.keys(parsed),
			...(deprecated ? { deprecated: true } : {}),
		});
		return parsed;
	}

	private readProjectFile(cwd: string): Partial<LmgrepConfig> | undefined {
		for (const name of ConfigLoader.PROJECT_FILE_NAMES) {
			const path = join(cwd, name);
			const raw = this.parseYaml(path);
			if (!raw) continue;

			const machineKeys = ConfigLoader.machineKeys().filter((k) => k in raw);
			if (machineKeys.length > 0) {
				// Named individually because the consequence differs per key:
				// a stray `model` here silently decided what an index meant.
				this.warnings.push(
					`${path}: ignoring ${machineKeys.join(", ")} — these describe your machine, ` +
						`not this repository. Set them in ${this.globalConfigPath()}. ` +
						"For a project-specific model, index it under `--in <name>` instead.",
				);
			}

			const parsed = ConfigLoader.PROJECT_SCHEMA.parse(
				this.pick(raw, ConfigLoader.projectKeys()),
			);
			this.sources.push({
				path,
				scope: "project",
				keys: Object.keys(parsed),
			});
			return parsed;
		}
		return undefined;
	}

	private parseYaml(path: string): Record<string, unknown> | undefined {
		if (!existsSync(path)) return undefined;
		const parsed = parse(readFileSync(path, "utf-8"));
		if (parsed == null || typeof parsed !== "object") return undefined;
		return parsed as Record<string, unknown>;
	}

	private pick(
		raw: Record<string, unknown>,
		keys: readonly string[],
	): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const key of keys) if (key in raw) out[key] = raw[key];
		return out;
	}

	private static machineKeys(): string[] {
		return Object.keys(ConfigLoader.MACHINE_SCHEMA.shape);
	}

	private static projectKeys(): string[] {
		return Object.keys(ConfigLoader.PROJECT_SCHEMA.shape);
	}

	private validate(
		config: Partial<LmgrepConfig> & typeof ConfigLoader.DEFAULTS,
	): LmgrepConfig {
		if (!config.model) {
			throw new Error(
				`No model configured. Run \`lmgrep init\` to detect your setup, or set \`model\` in ${this.globalConfigPath()}.`,
			);
		}
		return config as LmgrepConfig;
	}
}
