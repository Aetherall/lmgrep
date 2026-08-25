import { resolve } from "node:path";
import type { ChunkRepositoryPort } from "../../domain/ports/ChunkRepositoryPort.js";
import type { DatabaseLocation } from "../../domain/project/DatabaseLocation.js";
import type { ProjectLocator } from "../../domain/project/ProjectLocator.js";
import type { SearchCriteria } from "./SearchCriteria.js";

/** One index a search should consult. */
export interface SearchTarget {
	chunks: ChunkRepositoryPort;
	filePrefix?: string;
	/**
	 * Absolute root of a foreign project, used to make its relative paths
	 * meaningful here. Undefined for the local index.
	 */
	projectRoot?: string;
	/** Whether this target was opened for the query and must be closed after. */
	borrowed: boolean;
}

/** Opens a chunk repository for another project's database. */
export interface ForeignIndexOpener {
	open(projectPath: string): Promise<{
		chunks: ChunkRepositoryPort;
		close: () => Promise<void>;
	}>;
}

/**
 * Decides which indexes a search reads.
 *
 * Three cases, in precedence order: `--across` merges several projects,
 * `--project` redirects to one, and the default resolves the local project —
 * including the case where the working directory sits below an indexed root,
 * where the offset becomes a path prefix filter.
 */
export class SearchTargetResolver {
	private readonly opened = new Map<
		ChunkRepositoryPort,
		() => Promise<void>
	>();

	constructor(
		private readonly cwd: string,
		private readonly local: ChunkRepositoryPort,
		private readonly location: DatabaseLocation,
		private readonly locator: ProjectLocator,
		private readonly foreign: ForeignIndexOpener,
	) {}

	async resolve(criteria: SearchCriteria): Promise<SearchTarget[]> {
		const across = criteria.across;
		if (across && across.length > 0) {
			const targets: SearchTarget[] = [
				{
					chunks: this.local,
					filePrefix: criteria.filePrefix,
					borrowed: false,
				},
			];
			for (const path of across) {
				targets.push(await this.openForeign(path, criteria));
			}
			return targets;
		}

		if (criteria.project) {
			return [await this.openForeign(criteria.project, criteria)];
		}

		return [await this.resolveLocal(criteria)];
	}

	/** Close the databases this resolver opened; leave the local one alone. */
	async release(targets: SearchTarget[]): Promise<void> {
		for (const target of targets) {
			if (!target.borrowed) continue;
			const close = this.opened.get(target.chunks);
			if (!close) continue;
			this.opened.delete(target.chunks);
			await close();
		}
	}

	private async openForeign(
		path: string,
		criteria: SearchCriteria,
	): Promise<SearchTarget> {
		const absolute = resolve(this.cwd, path);
		const project = this.locator.resolveProject(absolute);
		const handle = await this.foreign.open(absolute);
		this.opened.set(handle.chunks, handle.close);
		return {
			chunks: handle.chunks,
			filePrefix: criteria.filePrefix,
			projectRoot: project.root,
			borrowed: true,
		};
	}

	/**
	 * The local index, with the working directory's offset from the project
	 * root folded into the prefix filter — so searching from `src/lib` only
	 * returns hits from there. A manually targeted database is flat and skips
	 * this entirely.
	 *
	 * Inside a git repo the ancestor resolves to the same database, because
	 * project identity is the remote. Outside git the walk-up can land on a
	 * genuinely different database — an indexed parent directory — which must
	 * be opened rather than substituted with the local one.
	 */
	private async resolveLocal(
		criteria: SearchCriteria,
	): Promise<SearchTarget> {
		const unscoped: SearchTarget = {
			chunks: this.local,
			filePrefix: criteria.filePrefix,
			borrowed: false,
		};
		if (!this.location.isGitAware) return unscoped;

		const ancestor = this.locator.findIndexedAncestor(this.cwd);
		if (!ancestor?.prefix) return unscoped;

		const prefix = criteria.filePrefix
			? `${ancestor.prefix}/${criteria.filePrefix}`
			: ancestor.prefix;

		const ancestorDatabase = this.locator.databasePathFor(ancestor.root);
		if (ancestorDatabase === this.location.path) {
			return { chunks: this.local, filePrefix: prefix, borrowed: false };
		}

		// A different database: the indexed root is a parent directory, and its
		// paths are relative to itself, so no relocation is applied.
		const handle = await this.foreign.open(ancestor.root);
		this.opened.set(handle.chunks, handle.close);
		return { chunks: handle.chunks, filePrefix: prefix, borrowed: true };
	}
}
