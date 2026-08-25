import type { FileManifestRepositoryPort } from "../../domain/ports/FileManifestRepositoryPort.js";
import type { GitPort } from "../../domain/ports/GitPort.js";
import type { LoggerPort } from "../../domain/ports/LoggerPort.js";

/**
 * Seeds a new branch's manifest from its closest relative.
 *
 * Checking out a branch would otherwise present as "nothing indexed" and
 * trigger a full re-embed of the whole tree, even though almost every file is
 * byte-identical to the branch it came from. Copying the nearest branch's
 * manifest turns that into a diff of the handful of files that actually differ.
 */
export class BranchBootstrapper {
	constructor(
		private readonly manifest: FileManifestRepositoryPort,
		private readonly git: GitPort,
		private readonly logger: LoggerPort,
	) {}

	/** No-op unless this branch's manifest is empty. */
	async bootstrap(repoRoot: string): Promise<void> {
		if (!(await this.manifest.current()).isEmpty) return;

		const stored = await this.manifest.storedBranches();
		if (stored.length === 0) return;

		const source = this.closestBranch(repoRoot, stored);
		if (!source) return;

		const copied = await this.manifest.copyFromBranch(source);
		if (copied > 0) {
			this.logger.info(
				`Bootstrapped from "${source}" manifest (${copied} files). Diffing changes...`,
			);
		}
	}

	/** The stored branch fewest commits behind HEAD. */
	private closestBranch(
		repoRoot: string,
		candidates: string[],
	): string | undefined {
		let best: string | undefined;
		let bestDistance = Number.POSITIVE_INFINITY;

		for (const candidate of candidates) {
			const mergeBase = this.git.mergeBase(repoRoot, candidate);
			if (!mergeBase) continue;
			const distance = this.git.commitDistance(repoRoot, mergeBase, "HEAD");
			if (distance === undefined) continue;
			if (distance < bestDistance) {
				bestDistance = distance;
				best = candidate;
			}
		}
		return best;
	}
}
