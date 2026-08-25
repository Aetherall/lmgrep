/** Option help text shared across commands. */
export class CliOptions {
	/**
	 * A bare name creates an independent index alongside the others; a path
	 * points at a specific directory. Without it, commands use the git-aware
	 * database for the working directory.
	 */
	static readonly DATABASE =
		"Target a specific database instead of the git-aware default: a bare name " +
		"creates an independent index under ~/.local/state/lmgrep/<name>, a path " +
		"points at a specific database directory";
}
