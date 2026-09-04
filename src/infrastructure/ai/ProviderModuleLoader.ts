import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import * as openAICompatible from "@ai-sdk/openai-compatible";

/**
 * Imports an AI SDK provider package.
 *
 * The OpenAI-compatible adapter is statically bundled so local runtimes work
 * in the standalone executable. Other providers remain plugins: resolution
 * reaches beyond this package's own `node_modules`, allowing a global install.
 */
export class ProviderModuleLoader {
	private readonly cache = new Map<string, Record<string, unknown>>();

	private readonly bundled = new Map<string, Record<string, unknown>>([
		["@ai-sdk/openai-compatible", openAICompatible],
	]);

	async load(packageName: string): Promise<Record<string, unknown>> {
		const bundled = this.bundled.get(packageName);
		if (bundled) return bundled;

		const cached = this.cache.get(packageName);
		if (cached) return cached;

		const loaded = await this.resolve(packageName);
		this.cache.set(packageName, loaded);
		return loaded;
	}

	private async resolve(packageName: string): Promise<Record<string, unknown>> {
		// Local resolution first — the common case.
		try {
			return await import(packageName);
		} catch {}

		for (const globalPath of this.globalModulePaths()) {
			try {
				const req = createRequire(join(globalPath, ".placeholder"));
				return await import(req.resolve(packageName));
			} catch {}
		}

		throw new Error(
			`Provider "${packageName}" is not installed. Run:\n\n  npm install -g ${packageName}\n`,
		);
	}

	private globalModulePaths(): string[] {
		const paths: string[] = [];
		for (const command of ["pnpm root -g", "npm root -g"]) {
			try {
				const out = execSync(command, { stdio: "pipe" }).toString().trim();
				if (out) paths.push(out);
			} catch {}
		}
		return paths;
	}
}
