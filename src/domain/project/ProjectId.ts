import { createHash } from "node:crypto";

/**
 * The identity of a project, and the on-disk slug derived from it.
 *
 * Identity is the git remote URL when there is one, so every worktree and
 * clone of the same repository shares a single index. Without a remote it
 * falls back to the git root, and outside git to the absolute path.
 */
export class ProjectId {
	private constructor(private readonly value: string) {}

	static of(value: string): ProjectId {
		return new ProjectId(value);
	}

	toString(): string {
		return this.value;
	}

	equals(other: ProjectId): boolean {
		return this.value === other.value;
	}

	/**
	 * Directory name for this project's database: a readable prefix plus a hash
	 * of the full identity. The prefix is for humans browsing the state
	 * directory; the hash is what actually guarantees uniqueness.
	 */
	toSlug(): string {
		const hash = createHash("sha256")
			.update(this.value)
			.digest("hex")
			.slice(0, 8);
		return `${this.readablePrefix()}-${hash}`;
	}

	/**
	 * Strip the git URL scheme and any trailing `.git` so worktrees of one repo
	 * produce the same prefix regardless of where they live on disk.
	 *   git@host:user/repo.git      -> user-repo
	 *   https://host/user/repo.git  -> user-repo
	 *   /abs/path/to/project        -> to-project
	 */
	private readablePrefix(): string {
		let s = this.value.replace(/\.git$/, "");
		const scpMatch = s.match(/^[^@]+@[^:]+:(.+)$/);
		if (scpMatch) {
			s = scpMatch[1];
		} else {
			s = s.replace(/^[a-z]+:\/\/[^/]+\//, "");
		}
		const parts = s.split("/").filter(Boolean);
		return parts.slice(-2).join("-").replace(/[^a-zA-Z0-9_-]/g, "_");
	}
}
