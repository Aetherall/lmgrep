import type { FileManifestRepositoryPort } from "../../domain/ports/FileManifestRepositoryPort.js";
import type { GitPort } from "../../domain/ports/GitPort.js";
import type { LoggerPort } from "../../domain/ports/LoggerPort.js";
import { Branch } from "../../domain/project/Branch.js";

/**
 * Drops manifests for branches git no longer has.
 *
 * Without this, every deleted feature branch leaves its file manifest behind
 * forever, and those rows keep chunks alive that nothing can reach — the index
 * grows monotonically across a project's lifetime.
 */
export class BranchManifestSweeper {
	constructor(
		private readonly manifest: FileManifestRepositoryPort,
		private readonly git: GitPort,
		private readonly logger: LoggerPort,
	) {}

	async sweep(repoRoot: string): Promise<void> {
		const branches = this.git.localBranches(repoRoot);
		// No git, or an unreadable repo: nothing can be proven stale, so leave
		// every manifest alone rather than guessing.
		if (branches.length === 0) return;

		const live = new Set(branches);
		// Non-git projects index under the default branch, which git never lists.
		live.add(Branch.DEFAULT_NAME);

		for (const stored of await this.manifest.storedBranches()) {
			if (live.has(stored)) continue;
			await this.manifest.deleteBranch(stored);
			this.logger.info(`Swept stale manifest for deleted branch "${stored}"`);
		}
	}
}
