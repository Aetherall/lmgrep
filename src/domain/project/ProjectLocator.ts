import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { GitPort } from "../ports/GitPort.js";
import type { StateDirectoryPort } from "../ports/StateDirectoryPort.js";
import { Branch } from "./Branch.js";
import { DatabaseLocation } from "./DatabaseLocation.js";
import { Project } from "./Project.js";
import { ProjectId } from "./ProjectId.js";

/** Where a working directory sits relative to the indexed project root. */
export interface IndexedAncestor {
	root: string;
	/** Subdirectory offset from the root, "" when they are the same. */
	prefix: string;
}

/**
 * Translates a working directory into a project identity and a database
 * location.
 *
 * This is the only place that knows the rules: git remote as identity so
 * worktrees share an index, path hashing outside git, and `--database` as a
 * manual override that turns off branch scoping.
 */
export class ProjectLocator {
	constructor(
		private readonly git: GitPort,
		private readonly state: StateDirectoryPort,
	) {}

	/**
	 * Identify the project containing `cwd`.
	 *
	 * A git repo is identified by its origin URL when it has one, so every
	 * worktree and clone maps to a single index; a remoteless repo falls back
	 * to its root path, and a plain directory to its own absolute path.
	 */
	resolveProject(cwd: string): Project {
		const absolute = resolve(cwd);

		const gitRoot = this.git.toplevel(absolute);
		if (gitRoot) {
			const branch = Branch.of(this.git.currentBranch(gitRoot) ?? "HEAD");
			const remoteUrl = this.git.originUrl(gitRoot);
			return new Project(
				ProjectId.of(remoteUrl ?? gitRoot),
				gitRoot,
				branch,
				remoteUrl,
			);
		}

		return new Project(
			ProjectId.of(absolute),
			absolute,
			Branch.default(),
		);
	}

	/** Database directory for the project containing `cwd`. */
	databasePathFor(cwd: string): string {
		return join(this.state.root(), this.resolveProject(cwd).id.toSlug());
	}

	/**
	 * Database path under the pre-git-aware scheme, which hashed the absolute
	 * path. Retained so `lmgrep import` can still find legacy indexes.
	 */
	legacyDatabasePathFor(cwd: string): string {
		const absolute = resolve(cwd);
		const hash = createHash("sha256")
			.update(absolute)
			.digest("hex")
			.slice(0, 6);
		const parts = absolute.split("/").filter(Boolean);
		const slug = parts
			.slice(-2)
			.join("-")
			.replace(/[^a-zA-Z0-9_-]/g, "_");
		return join(this.state.root(), `${slug}-${hash}`);
	}

	/**
	 * Decide which database a command targets.
	 *
	 * With no override this is the git-aware default. An override containing a
	 * separator is a path to a specific database directory; a bare name creates
	 * an independent database alongside the others. Either way the result is
	 * flat and branch-agnostic — indexing and search both use the default
	 * branch, so switching git branches never hides results in a database the
	 * user asked for explicitly. `cwd` still drives file scanning; only the
	 * database identity changes.
	 */
	resolveDatabase(cwd: string, database?: string): DatabaseLocation {
		if (database && database.length > 0) {
			const path = this.isPathLike(database)
				? resolve(cwd, database)
				: join(
						this.state.root(),
						database.replace(/[^a-zA-Z0-9_.-]/g, "_"),
					);
			return new DatabaseLocation(
				path,
				Branch.default(),
				resolve(cwd),
				true,
			);
		}

		const project = this.resolveProject(cwd);
		return new DatabaseLocation(
			this.databasePathFor(cwd),
			project.branch,
			project.root,
			false,
		);
	}

	/**
	 * Find the indexed project root covering `cwd` and the prefix from it.
	 *
	 * For a git repo the root is the toplevel. Outside git, walks up looking
	 * for an ancestor that already has an index, so running from a
	 * subdirectory of an indexed tree still finds it.
	 */
	findIndexedAncestor(cwd: string): IndexedAncestor | undefined {
		const absolute = resolve(cwd);
		const root = this.resolveProject(cwd).root;

		if (this.state.isDirectory(this.databasePathFor(root))) {
			return {
				root,
				prefix: root === absolute ? "" : absolute.slice(root.length + 1),
			};
		}

		// Only plain directories climb: inside a git repo the toplevel is
		// definitive, so a miss there means there is genuinely no index.
		if (root === absolute) {
			let current = resolve(absolute, "..");
			for (;;) {
				if (this.state.isDirectory(this.databasePathFor(current))) {
					return {
						root: current,
						prefix: absolute.slice(current.length + 1),
					};
				}
				const parent = resolve(current, "..");
				if (parent === current) break;
				current = parent;
			}
		}

		return undefined;
	}

	/** A `--database` override is a path when it carries a separator. */
	private isPathLike(value: string): boolean {
		return (
			value.includes("/") ||
			value.includes("\\") ||
			value === "." ||
			value === ".."
		);
	}
}
