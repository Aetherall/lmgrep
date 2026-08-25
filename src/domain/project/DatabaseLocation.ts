import type { Branch } from "./Branch.js";

/**
 * The fully-resolved database a command reads from and writes to.
 *
 * `manual` records how it was chosen, because that changes behaviour
 * downstream: a manually targeted database is flat (no branch scoping, no
 * ancestor prefix walking), while the git-aware default participates in both.
 */
export class DatabaseLocation {
	constructor(
		/** Absolute path to the database directory. */
		readonly path: string,
		/** Branch scope to read and write. */
		readonly branch: Branch,
		/** Project root used for metadata and status display. */
		readonly root: string,
		/** True when chosen explicitly via `--database`. */
		readonly manual: boolean,
	) {}

	/**
	 * Whether this database participates in branch scoping and ancestor
	 * resolution. False for `--database` targets, which are deliberately flat.
	 */
	get isGitAware(): boolean {
		return !this.manual;
	}
}
