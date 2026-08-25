import { dirname, join, resolve } from "node:path";
import type { GitPort } from "../ports/GitPort.js";
import type { StateDirectoryPort } from "../ports/StateDirectoryPort.js";
import { Branch } from "./Branch.js";
import { DatabaseLocation } from "./DatabaseLocation.js";
import type { ModelIdentity } from "./ModelIdentity.js";
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
 * This is the only place that knows the rules, and there are three:
 *
 * **A repository's index lives inside it**, at `<git-common-dir>/lmgrep/`.
 * Git resolves that to the main checkout's `.git` even from a linked worktree,
 * so every worktree of a repository agrees on one index by construction rather
 * than by a shared registry that could disagree with reality. It also means
 * the index is found by `du`, deleted by `rm -rf`, and gone when the clone is
 * — which is what stops orphaned databases from accumulating somewhere the
 * user never looks. Git never walks its own directory, so nothing here is ever
 * committed or indexed.
 *
 * **Each embedding model gets its own database.** Vectors from different
 * models are not comparable, so pointing lmgrep at a new model used to mean
 * discarding the index or searching it with embeddings that quietly meant
 * nothing. Keyed by model, switching is just a different subdirectory, and
 * switching back finds the old index intact.
 *
 * **Everything else falls back to the state directory**: projects outside git
 * have no repository to live in, and `--database <name>` is by definition not
 * tied to one.
 */
export class ProjectLocator {
	/** Subdirectory of the git common directory holding every model's index. */
	private static readonly REPOSITORY_SUBDIRECTORY = "lmgrep";

	constructor(
		private readonly git: GitPort,
		private readonly state: StateDirectoryPort,
		/** The configured embedding model, which partitions the databases. */
		private readonly model: ModelIdentity,
		/** Configured output width, when the model has a configurable one. */
		private readonly dimensions?: number,
	) {}

	/**
	 * Identify the project containing `cwd`.
	 *
	 * A git repo is identified by its origin URL when it has one, so every
	 * worktree and clone maps to a single identity; a remoteless repo falls
	 * back to its root path, and a plain directory to its own absolute path.
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

		return new Project(ProjectId.of(absolute), absolute, Branch.default());
	}

	/** The directory holding every model's index for the project at `cwd`. */
	indexHomeFor(cwd: string): string {
		const commonDir = this.git.commonDir(resolve(cwd));
		if (commonDir) {
			return join(commonDir, ProjectLocator.REPOSITORY_SUBDIRECTORY);
		}
		return join(
			this.state.databasesDirectory(),
			this.resolveProject(cwd).id.toSlug(),
		);
	}

	/** Database directory for the project containing `cwd`. */
	databasePathFor(cwd: string): string {
		return join(this.indexHomeFor(cwd), this.modelSlug());
	}

	/**
	 * The working tree a repository index belongs to, for display and for the
	 * registry.
	 *
	 * Worktrees share one database, so the toplevel of whichever worktree
	 * happened to run the index would name an arbitrary one of them. The main
	 * checkout — the parent of the common directory — is the stable answer.
	 */
	projectRootFor(cwd: string): string {
		const commonDir = this.git.commonDir(resolve(cwd));
		return commonDir ? dirname(commonDir) : this.resolveProject(cwd).root;
	}

	/** Directory name the configured model's embeddings are stored under. */
	modelSlug(): string {
		return this.model.toSlug(this.dimensions);
	}

	/**
	 * Where an index built with `model` belongs.
	 *
	 * Needed when adopting a database written by an older layout, which knows
	 * which model built it but not which slot the current rules would put it
	 * in. It must go through here rather than deriving a slug independently:
	 * the width only counts when it was *configured*, since an index records
	 * the width it observed and that is the model's native size whenever
	 * nothing was requested. Computing the slug from the recorded width
	 * instead produced a directory the locator would never look in — an
	 * adopted index that was silently invisible.
	 */
	databasePathForModel(cwd: string, model: ModelIdentity): string {
		const dimensions = model.isSameFamilyAs(this.model)
			? this.dimensions
			: undefined;
		return join(this.indexHomeFor(cwd), model.toSlug(dimensions));
	}

	/**
	 * Decide which database a command targets.
	 *
	 * With no override this is the repository's index for the configured
	 * model. An override containing a separator is taken literally — it is an
	 * exact address, and appending anything to it would make it impossible to
	 * point at a database that already exists. A bare name is an identity
	 * instead, so it is model-scoped like any other.
	 *
	 * Either way the result is flat and branch-agnostic: indexing and search
	 * both use the default branch, so switching git branches never hides
	 * results in a database the user asked for explicitly. `cwd` still drives
	 * file scanning; only the database identity changes.
	 */
	resolveDatabase(cwd: string, database?: string): DatabaseLocation {
		if (database && database.length > 0) {
			const path = this.isPathLike(database)
				? resolve(cwd, database)
				: join(
						this.state.databasesDirectory(),
						database.replace(/[^a-zA-Z0-9_.-]/g, "_"),
						this.modelSlug(),
					);
			return new DatabaseLocation(path, Branch.default(), resolve(cwd), true);
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
