import type { Branch } from "./Branch.js";
import type { ProjectId } from "./ProjectId.js";

/** A resolved project: its identity, working-tree root and current branch. */
export class Project {
	constructor(
		readonly id: ProjectId,
		/** Git toplevel, or the absolute directory outside a repo. */
		readonly root: string,
		readonly branch: Branch,
		/** Origin remote URL, when the project has one. */
		readonly remote?: string,
	) {}

	get isGitRepository(): boolean {
		return this.remote !== undefined || this.branch.toString() !== "_default";
	}
}
