import { readFileSync, existsSync, watch, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, extname, relative, dirname } from "node:path";
import { globSync } from "glob";
import ignore, { type Ignore } from "ignore";
import type { FileChange, FileEntry } from "./types.js";

export const DEFAULT_IGNORE = [
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	"__pycache__",
	".venv",
	"vendor",
	"target",
	".lmgrep",
	"*.min.js",
	"*.min.css",
	"*.map",
	"*.lock",
	"pnpm-lock.yaml",
	"package-lock.json",
	"yarn.lock",
	"*.png",
	"*.jpg",
	"*.jpeg",
	"*.gif",
	"*.ico",
	"*.woff",
	"*.woff2",
	"*.ttf",
	"*.eot",
	"*.svg",
	"*.zip",
	"*.tar",
	"*.gz",
	"*.bin",
	"*.exe",
	"*.dll",
	"*.so",
	"*.dylib",
	"*.wasm",
];

export const CODE_EXTENSIONS = new Set([
	".js",
	".ts",
	".jsx",
	".tsx",
	".py",
	".rs",
	".go",
	".rb",
	".c",
	".h",
	".cpp",
	".hpp",
	".cc",
	".swift",
	".json",
	".yaml",
	".yml",
	".toml",
	".lua",
	".scala",
	".zig",
	".md",
	".markdown",
	".mdx",
	".sh",
	".bash",
	".sql",
	".graphql",
	".gql",
	".proto",
	".html",
	".css",
	".scss",
	".vue",
	".svelte",
	".nix",
	".tf",
	".hcl",
	".kt",
	".java",
	".php",
	".cs",
	".rst",
	".adoc",
]);

export interface ExtensionConfig {
	include?: string[];
	exclude?: string[];
}

function buildExtensionSet(config?: ExtensionConfig): Set<string> {
	const exts = new Set(CODE_EXTENSIONS);
	if (config?.include) {
		for (const ext of config.include) exts.add(ext);
	}
	if (config?.exclude) {
		for (const ext of config.exclude) exts.delete(ext);
	}
	return exts;
}

function isCodeFile(filePath: string, exts: Set<string>): boolean {
	const ext = extname(filePath);
	return exts.has(ext);
}

function buildIgnoreFilter(cwd: string, extraPatterns?: string[]): Ignore {
	const ig = ignore();
	ig.add(DEFAULT_IGNORE);

	if (extraPatterns) {
		ig.add(extraPatterns);
	}

	const gitignorePath = join(cwd, ".gitignore");
	if (existsSync(gitignorePath)) {
		ig.add(readFileSync(gitignorePath, "utf-8"));
	}

	const lmgrepIgnorePath = join(cwd, ".lmgrepignore");
	if (existsSync(lmgrepIgnorePath)) {
		ig.add(readFileSync(lmgrepIgnorePath, "utf-8"));
	}

	return ig;
}

/**
 * Walk the directory tree and yield file entries.
 * Reads nested .gitignore files at each directory level.
 */
export function walkFiles(cwd: string, extraIgnore?: string[], extensions?: ExtensionConfig): string[] {
	const ig = buildIgnoreFilter(cwd, extraIgnore);
	const exts = buildExtensionSet(extensions);

	// Collect nested .gitignore rules
	const allFiles = globSync("**/*", { cwd, nodir: true, dot: false });

	// Build a set of directories that have .gitignore files
	const nestedIgnores = new Map<string, Ignore>();
	for (const f of allFiles) {
		if (f.endsWith("/.gitignore") || f === ".gitignore") continue;
		const dir = dirname(f);
		if (dir === "." || nestedIgnores.has(dir)) continue;

		const nestedPath = join(cwd, dir, ".gitignore");
		if (existsSync(nestedPath)) {
			const nested = ignore();
			nested.add(readFileSync(nestedPath, "utf-8"));
			nestedIgnores.set(dir, nested);
		}
	}

	return allFiles.filter((f) => {
		if (!isCodeFile(f, exts)) return false;
		if (ig.ignores(f)) return false;

		// Check nested .gitignore rules
		for (const [dir, nested] of nestedIgnores) {
			if (f.startsWith(dir + "/")) {
				const rel = f.slice(dir.length + 1);
				if (nested.ignores(rel)) return false;
			}
		}

		return true;
	});
}

/**
 * Hash a file's content for change detection.
 */
export function hashFile(cwd: string, filePath: string): string | undefined {
	try {
		const content = readFileSync(join(cwd, filePath));
		return createHash("sha256").update(content).digest("hex").slice(0, 16);
	} catch {
		return undefined;
	}
}

/**
 * Compute changed files by comparing disk hashes against stored hashes.
 */
export function detectChanges(
	files: string[],
	storedHashes: Map<string, string>,
	cwd: string,
	force = false,
): { changed: FileEntry[]; currentHashes: Map<string, string> } {
	const changed: FileEntry[] = [];
	const currentHashes = new Map<string, string>();

	for (const file of files) {
		const hash = hashFile(cwd, file);
		if (!hash) continue;

		currentHashes.set(file, hash);
		if (force || storedHashes.get(file) !== hash) {
			changed.push({ path: file, hash });
		}
	}

	return { changed, currentHashes };
}

/**
 * Filter files by modification time.
 */
export function filterByMtime(
	files: string[],
	cwd: string,
	cutoffMs: number,
): string[] {
	return files.filter((f) => {
		try {
			return statSync(join(cwd, f)).mtimeMs >= cutoffMs;
		} catch {
			return false;
		}
	});
}

/**
 * Watch a directory for code file changes. Calls the callback with debouncing.
 * Collects changed file paths during the debounce window and passes them to the callback.
 */
export function watchFiles(
	cwd: string,
	extraIgnore: string[] | undefined,
	onChanges: (changedFiles: string[]) => void,
	debounceMs = 2000,
	extensions?: ExtensionConfig,
): { close: () => void } {
	const ig = buildIgnoreFilter(cwd, extraIgnore);
	const exts = buildExtensionSet(extensions);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending = new Set<string>();

	const watcher = watch(cwd, { recursive: true }, (_event, filename) => {
		if (!filename) return;
		if (!isCodeFile(filename, exts)) return;
		try {
			if (ig.ignores(filename)) return;
		} catch {
			return;
		}

		pending.add(filename);
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			const files = [...pending];
			pending = new Set();
			onChanges(files);
		}, debounceMs);
	});

	return {
		close() {
			if (timer) clearTimeout(timer);
			watcher.close();
		},
	};
}
