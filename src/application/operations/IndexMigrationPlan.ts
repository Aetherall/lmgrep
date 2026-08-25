import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StateDirectoryPort } from "../../domain/ports/StateDirectoryPort.js";
import { ProjectId } from "../../domain/project/ProjectId.js";
import type { DiscoveredProject } from "../../infrastructure/fs/ProjectMetadataStore.js";

/** One index directory that should move, and whether it can. */
export interface PlannedMove {
	from: string;
	to: string;
	id: string;
	/**
	 * Another index already occupies the target. Almost always a sibling
	 * worktree that has already been unified, so the source is redundant — but
	 * that is the user's call, not ours to delete.
	 */
	conflict: boolean;
}

/**
 * Works out which index directories predate the current slug scheme.
 *
 * The scheme changed when project identity became the git remote, so worktrees
 * of one repo could share an index. Migration is renaming each directory to
 * the name that identity produces today.
 */
export class IndexMigrationPlan {
	constructor(private readonly state: StateDirectoryPort) {}

	plan(projects: readonly DiscoveredProject[]): PlannedMove[] {
		const base = this.state.root();
		const moves: PlannedMove[] = [];

		// Targets already occupied by a correctly-named index. Anything else
		// mapping there is a conflict, not a move.
		const claimed = new Set<string>();
		for (const { databasePath, metadata } of projects) {
			const target = this.targetFor(base, metadata);
			if (resolve(databasePath) === target) claimed.add(target);
		}

		for (const { databasePath, metadata } of projects) {
			const target = this.targetFor(base, metadata);
			if (resolve(databasePath) === target) continue;

			const conflict = claimed.has(target) || existsSync(target);
			moves.push({
				from: databasePath,
				to: target,
				id: metadata.remote ?? metadata.root,
				conflict,
			});
			// The first non-conflicting mover claims the target, so a later one
			// in the same run sees the conflict.
			if (!conflict) claimed.add(target);
		}

		return moves;
	}

	private targetFor(
		base: string,
		metadata: { remote?: string; root: string },
	): string {
		const id = ProjectId.of(metadata.remote ?? metadata.root);
		return resolve(join(base, id.toSlug()));
	}
}
