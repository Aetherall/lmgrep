import { readFileSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { LmgrepConfig } from "./types.js";

const ConfigSchema = z.object({
	model: z
		.string()
		.regex(/^.+:.+$/, 'Model must be in "provider:model" format (e.g. "ollama:nomic-embed-text")'),
	provider: z.string().optional(),
	baseURL: z.string().url().optional(),
	local: z.boolean().optional(),
	batchSize: z.number().int().positive().default(100),
	dimensions: z.number().int().positive().optional(),
	queryPrefix: z.string().optional(),
	documentPrefix: z.string().optional(),
	maxTokens: z.number().int().positive().optional(),
	ignore: z.array(z.string()).optional(),
	extensions: z
		.object({
			include: z.array(z.string()).optional(),
			exclude: z.array(z.string()).optional(),
		})
		.optional(),
});

const CONFIG_FILE = "config.yml";

const DEFAULTS: Omit<LmgrepConfig, "model"> & { model?: string } = {
	batchSize: 100,
};

/**
 * Return the XDG-compliant global config directory for lmgrep.
 *   Linux:  $XDG_CONFIG_HOME/lmgrep  or  ~/.config/lmgrep
 *   macOS:  ~/Library/Application Support/lmgrep
 */
export function getConfigDir(): string {
	if (platform() === "darwin") {
		return join(homedir(), "Library", "Application Support", "lmgrep");
	}
	const xdg = process.env.XDG_CONFIG_HOME;
	return join(xdg || join(homedir(), ".config"), "lmgrep");
}

/**
 * Return the path to the global config file.
 */
export function getGlobalConfigPath(): string {
	return join(getConfigDir(), CONFIG_FILE);
}

function tryLoadFile(path: string): Partial<LmgrepConfig> | undefined {
	if (!existsSync(path)) return undefined;
	const raw = readFileSync(path, "utf-8");
	const parsed = parse(raw);
	if (parsed == null || typeof parsed !== "object") return undefined;
	return ConfigSchema.partial().parse(parsed);
}

export function loadConfig(cwd: string): LmgrepConfig {
	// Project-local config (.lmgrep.yml in project root)
	for (const name of [".lmgrep.yml", ".lmgrep.yaml"]) {
		const found = tryLoadFile(join(cwd, name));
		if (found) return validateConfig({ ...DEFAULTS, ...found });
	}

	// Global config (XDG config dir)
	const globalConfig = tryLoadFile(getGlobalConfigPath());
	if (globalConfig) return validateConfig({ ...DEFAULTS, ...globalConfig });

	// Legacy: ~/.lmgrep.yml (for backwards compat)
	for (const name of [".lmgrep.yml", ".lmgrep.yaml"]) {
		const found = tryLoadFile(join(homedir(), name));
		if (found) return validateConfig({ ...DEFAULTS, ...found });
	}

	throw new Error(
		"No configuration found. Run `lmgrep init` to set up your embedding model.",
	);
}

function validateConfig(
	config: Partial<LmgrepConfig> & typeof DEFAULTS,
): LmgrepConfig {
	if (!config.model) {
		throw new Error(
			"No model configured. Set `model` in .lmgrep.yml (e.g. `model: ollama:nomic-embed-text`).\n" +
				"Run `lmgrep init` to auto-detect your setup.",
		);
	}
	return config as LmgrepConfig;
}
