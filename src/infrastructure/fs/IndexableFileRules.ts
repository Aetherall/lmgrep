import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { ExtensionRules } from "../../domain/ports/WorkspacePort.js";

/**
 * Decides which files are worth indexing.
 *
 * Two independent filters: an extension allow-list (is this even source?) and
 * ignore patterns (should this source be skipped?). Ignore rules come from the
 * built-in list, the user's config, `.gitignore` and `.lmgrepignore`, plus
 * nested `.gitignore` files further down the tree.
 */
export class IndexableFileRules {
	static readonly DEFAULT_IGNORE = [
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

	static readonly CODE_EXTENSIONS = new Set([
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

	private readonly root: Ignore;
	private readonly extensions: Set<string>;
	private readonly nested = new Map<string, Ignore>();

	constructor(
		private readonly cwd: string,
		extraIgnore?: string[],
		extensionRules?: ExtensionRules,
	) {
		this.root = IndexableFileRules.buildIgnore(cwd, extraIgnore);
		this.extensions = IndexableFileRules.buildExtensions(extensionRules);
	}

	/** Whether the path's extension is one we index at all. */
	hasIndexableExtension(filePath: string): boolean {
		return this.extensions.has(extname(filePath));
	}

	/** Whether the root-level ignore rules exclude this path. */
	isIgnored(filePath: string): boolean {
		try {
			return this.root.ignores(filePath);
		} catch {
			// `ignore` rejects paths it considers malformed; treat those as
			// ignorable rather than letting one bad name abort a whole scan.
			return true;
		}
	}

	/**
	 * Load `.gitignore` files sitting in subdirectories, so a nested ignore
	 * applies to its own subtree the way git applies it.
	 */
	loadNestedIgnores(relativePaths: readonly string[]): void {
		for (const f of relativePaths) {
			if (f.endsWith("/.gitignore") || f === ".gitignore") continue;
			const dir = dirname(f);
			if (dir === "." || this.nested.has(dir)) continue;

			const nestedPath = join(this.cwd, dir, ".gitignore");
			if (!existsSync(nestedPath)) continue;
			const rules = ignore();
			rules.add(readFileSync(nestedPath, "utf-8"));
			this.nested.set(dir, rules);
		}
	}

	/** Whether any nested `.gitignore` excludes this path. */
	isIgnoredByNested(filePath: string): boolean {
		for (const [dir, rules] of this.nested) {
			if (!filePath.startsWith(`${dir}/`)) continue;
			if (rules.ignores(filePath.slice(dir.length + 1))) return true;
		}
		return false;
	}

	/** Full decision for a scanned path. */
	admits(filePath: string): boolean {
		return (
			this.hasIndexableExtension(filePath) &&
			!this.isIgnored(filePath) &&
			!this.isIgnoredByNested(filePath)
		);
	}

	private static buildIgnore(cwd: string, extra?: string[]): Ignore {
		const rules = ignore();
		rules.add([...IndexableFileRules.DEFAULT_IGNORE]);
		if (extra) rules.add(extra);

		for (const name of [".gitignore", ".lmgrepignore"]) {
			const path = join(cwd, name);
			if (existsSync(path)) rules.add(readFileSync(path, "utf-8"));
		}
		return rules;
	}

	private static buildExtensions(rules?: ExtensionRules): Set<string> {
		const exts = new Set(IndexableFileRules.CODE_EXTENSIONS);
		for (const e of rules?.include ?? []) exts.add(e);
		for (const e of rules?.exclude ?? []) exts.delete(e);
		return exts;
	}
}
