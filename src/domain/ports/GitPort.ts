/**
 * The git facts the domain needs. Narrow on purpose: project identity and
 * branch topology only, so the domain never learns that git is a subprocess.
 */
export interface GitPort {
	/** Absolute path of the working tree root, or undefined outside a repo. */
	toplevel(cwd: string): string | undefined;
	/** Current branch name, or "HEAD" when detached. */
	currentBranch(repoRoot: string): string | undefined;
	/** URL of the `origin` remote, if one is configured. */
	originUrl(repoRoot: string): string | undefined;
	/** Merge base of `HEAD` and `ref`, if both are reachable. */
	mergeBase(repoRoot: string, ref: string): string | undefined;
	/** Number of commits `to` is ahead of `from`. */
	commitDistance(repoRoot: string, from: string, to: string): number | undefined;
	/** Local branch names. */
	localBranches(repoRoot: string): string[];
}
