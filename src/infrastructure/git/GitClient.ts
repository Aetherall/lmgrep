import { execSync } from "node:child_process";
import type { GitPort } from "../../domain/ports/GitPort.js";

/**
 * GitPort over the `git` binary.
 *
 * Every call is best-effort: a missing binary, a non-repo directory, or a
 * detached/oprhaned state all surface as `undefined` rather than throwing,
 * because every caller treats "not a git repo" as an ordinary case.
 */
export class GitClient implements GitPort {
	private static readonly TIMEOUT_MS = 5000;

	toplevel(cwd: string): string | undefined {
		return this.run(cwd, "rev-parse", "--show-toplevel");
	}

	currentBranch(repoRoot: string): string | undefined {
		return this.run(repoRoot, "rev-parse", "--abbrev-ref", "HEAD");
	}

	originUrl(repoRoot: string): string | undefined {
		return this.run(repoRoot, "remote", "get-url", "origin");
	}

	mergeBase(repoRoot: string, ref: string): string | undefined {
		return this.run(repoRoot, "merge-base", "HEAD", ref);
	}

	commitDistance(
		repoRoot: string,
		from: string,
		to: string,
	): number | undefined {
		const out = this.run(repoRoot, "rev-list", "--count", `${from}..${to}`);
		if (out === undefined) return undefined;
		const n = Number.parseInt(out, 10);
		return Number.isNaN(n) ? undefined : n;
	}

	localBranches(repoRoot: string): string[] {
		const out = this.run(
			repoRoot,
			"for-each-ref",
			"--format=%(refname:short)",
			"refs/heads",
		);
		if (!out) return [];
		return out
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
	}

	private run(cwd: string, ...args: string[]): string | undefined {
		try {
			return execSync(`git ${args.join(" ")}`, {
				cwd,
				stdio: ["ignore", "pipe", "ignore"],
				timeout: GitClient.TIMEOUT_MS,
			})
				.toString()
				.trim();
		} catch {
			return undefined;
		}
	}
}
