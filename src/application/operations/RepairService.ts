import type { ChunkRepositoryPort } from "../../domain/ports/ChunkRepositoryPort.js";
import type { FileManifestRepositoryPort } from "../../domain/ports/FileManifestRepositoryPort.js";
import type { LoggerPort } from "../../domain/ports/LoggerPort.js";
import type { WorkspacePort } from "../../domain/ports/WorkspacePort.js";

export interface RepairResult {
	/** Manifest paths that no longer exist on disk. */
	orphaned: string[];
	/** Manifest paths whose stored hash disagrees with disk. */
	stale: string[];
	chunksRemoved: number;
}

/**
 * Reconciles the branch manifest with the working tree.
 *
 * The manifest is the index's record of what it has seen; if it drifts from
 * reality — a file deleted outside a watch window, an interrupted write — the
 * affected files look up to date and are never re-indexed. Dropping those rows
 * makes the next run treat them as new.
 */
export class RepairService {
	constructor(
		private readonly workspace: WorkspacePort,
		private readonly chunks: ChunkRepositoryPort,
		private readonly manifest: FileManifestRepositoryPort,
		private readonly logger: LoggerPort,
	) {}

	async repair(cwd: string, dryRun = false): Promise<RepairResult> {
		this.logger.info(
			"Reconciling current-branch manifest with working tree...",
		);

		const before = await this.chunks.count();
		const stored = await this.manifest.current();
		const onDisk = new Set(this.workspace.listFiles(cwd));

		const orphaned: string[] = [];
		const stale: string[] = [];

		for (const [path, storedHash] of stored) {
			if (!onDisk.has(path)) {
				orphaned.push(path);
				continue;
			}
			const current = this.workspace.hashOf(cwd, path);
			// Unreadable now: treat as gone rather than leaving a row that can
			// never be validated.
			if (current === undefined) {
				orphaned.push(path);
				continue;
			}
			if (!current.equals(storedHash)) stale.push(path);
		}

		const total = orphaned.length + stale.length;
		if (total === 0) {
			this.logger.info("Manifest matches working tree. No repairs needed.");
			return { orphaned: [], stale: [], chunksRemoved: 0 };
		}

		this.logger.info(`Found ${total} inconsistencies:`);
		if (orphaned.length > 0) {
			this.logger.info(`  ${orphaned.length} orphaned files`);
		}
		if (stale.length > 0) this.logger.info(`  ${stale.length} stale files`);

		if (dryRun) {
			for (const path of orphaned) this.logger.info(`  [orphan] ${path}`);
			for (const path of stale) this.logger.info(`  [stale]  ${path}`);
			return { orphaned, stale, chunksRemoved: 0 };
		}

		const toDrop = [...orphaned, ...stale];
		await this.chunks.deleteByFiles(toDrop);
		await this.manifest.deleteFiles(toDrop);

		const chunksRemoved = before - (await this.chunks.count());
		this.logger.info(
			`Dropped ${toDrop.length} manifest entries (${chunksRemoved} chunks removed). ` +
				"Run `lmgrep index` to re-embed stale files.",
		);

		return { orphaned, stale, chunksRemoved };
	}
}
