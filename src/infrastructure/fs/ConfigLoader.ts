import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";

/**
 * Loads configuration by layering files, later layers overriding earlier ones
 * field by field.
 *
 * Precedence is project > global > legacy home > defaults, so a global config
 * can hold shared settings (a `chatModel`, say) while a project `.lmgrep.yml`
 * overrides only what it needs. Field-wise merging is what makes that work —
 * a whole-file override would force every project to restate everything.
 */
export class ConfigLoader {
	private static readonly SCHEMA = z.object({
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

	load(cwd: string): LmgrepConfig {
		const layers: Array<Partial<LmgrepConfig>> = [];

		// Legacy ~/.lmgrep.yml, lowest priority, kept for backwards compat.
		const legacy = this.firstExisting(
			ConfigLoader.PROJECT_FILE_NAMES.map((n) => join(homedir(), n)),
		);
		if (legacy) layers.push(legacy);

		const global = this.tryLoadFile(this.globalConfigPath());
		if (global) layers.push(global);

		const project = this.firstExisting(
			ConfigLoader.PROJECT_FILE_NAMES.map((n) => join(cwd, n)),
		);
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

	private firstExisting(paths: string[]): Partial<LmgrepConfig> | undefined {
		for (const path of paths) {
			const found = this.tryLoadFile(path);
			if (found) return found;
		}
		return undefined;
	}

	private tryLoadFile(path: string): Partial<LmgrepConfig> | undefined {
		if (!existsSync(path)) return undefined;
		const parsed = parse(readFileSync(path, "utf-8"));
		if (parsed == null || typeof parsed !== "object") return undefined;
		return ConfigLoader.SCHEMA.partial().parse(parsed);
	}

	private validate(
		config: Partial<LmgrepConfig> & typeof ConfigLoader.DEFAULTS,
	): LmgrepConfig {
		if (!config.model) {
			throw new Error(
				"No model configured. Set `model` in .lmgrep.yml (e.g. `model: ollama:nomic-embed-text`).\n" +
					"Run `lmgrep init` to auto-detect your setup.",
			);
		}
		return config as LmgrepConfig;
	}
}
