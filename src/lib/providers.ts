import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

function getGlobalNodeModulesPaths(): string[] {
	const paths: string[] = [];

	try {
		const pnpmGlobal = execSync("pnpm root -g", { stdio: "pipe" })
			.toString()
			.trim();
		if (pnpmGlobal) paths.push(pnpmGlobal);
	} catch {}

	try {
		const npmGlobal = execSync("npm root -g", { stdio: "pipe" })
			.toString()
			.trim();
		if (npmGlobal) paths.push(npmGlobal);
	} catch {}

	return paths;
}

export async function importProvider(
	pkg: string,
): Promise<Record<string, unknown>> {
	// Try normal resolution first (works for local installs)
	try {
		return await import(pkg);
	} catch {}

	// Try global node_modules paths
	for (const globalPath of getGlobalNodeModulesPaths()) {
		try {
			const req = createRequire(join(globalPath, ".placeholder"));
			const resolved = req.resolve(pkg);
			return await import(resolved);
		} catch {}
	}

	throw new Error(
		`Provider "${pkg}" is not installed. Run:\n\n  npm install -g ${pkg}\n`,
	);
}
