import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IndexMetadataPort } from "../../domain/ports/IndexMetadataPort.js";
import type { IndexMetadata } from "../../domain/project/IndexMetadata.js";
import { TableName } from "../lancedb/LanceTables.js";

/**
 * The `lmgrep.json` sidecar written beside each database.
 *
 * It records the model and dimensions the index was built with, which is what
 * lets a later search refuse to run against incompatible embeddings instead of
 * silently returning nonsense.
 */
export class ProjectMetadataStore implements IndexMetadataPort {
	private static readonly FILE = "lmgrep.json";
	/** What an lmgrep database looks like from the outside. */
	private static readonly MARKERS = new Set<string>([
		ProjectMetadataStore.FILE,
		`${TableName.Chunks}.lance`,
		`${TableName.Files}.lance`,
		`${TableName.LegacyVocab}.lance`,
	]);

	read(databasePath: string): IndexMetadata | undefined {
		try {
			return JSON.parse(
				readFileSync(join(databasePath, ProjectMetadataStore.FILE), "utf-8"),
			) as IndexMetadata;
		} catch {
			return undefined;
		}
	}

	/**
	 * Write the sidecar, preserving the model and dimensions already recorded.
	 *
	 * The first index establishes the baseline; later writes must not overwrite
	 * it, or a search with a different model would stop being detectable as a
	 * mismatch.
	 */
	write(
		databasePath: string,
		metadata: Omit<IndexMetadata, "indexedAt">,
	): void {
		mkdirSync(databasePath, { recursive: true });
		const existing = this.read(databasePath);
		const merged: IndexMetadata = {
			root: metadata.root,
			remote: metadata.remote,
			branch: metadata.branch,
			indexedAt: new Date().toISOString(),
			model: existing?.model ?? metadata.model,
			dimensions: existing?.dimensions ?? metadata.dimensions,
		};
		writeFileSync(
			join(databasePath, ProjectMetadataStore.FILE),
			JSON.stringify(merged, null, 2),
		);
	}

	/**
	 * Whether a directory holds an lmgrep database, or is an empty directory
	 * safe to treat as one.
	 *
	 * `--database <path>` lets a caller aim any directory at any command, so a
	 * destructive operation must confirm the target is ours before touching it
	 * — without this, `lmgrep prune --database .` would delete a working tree.
	 * An empty directory passes because that is what an interrupted index
	 * leaves behind, and removing it cannot lose data.
	 */
	isDatabaseDirectory(databasePath: string): boolean {
		let entries: string[];
		try {
			entries = readdirSync(databasePath);
		} catch {
			return false;
		}
		if (entries.length === 0) return true;
		return entries.some((e) => ProjectMetadataStore.MARKERS.has(e));
	}

	/**
	 * Whether a directory actually holds an index.
	 *
	 * Same markers as {@link isDatabaseDirectory}, without its allowance for
	 * an empty directory — the two are kept on one marker set so that what
	 * counts as a database is defined in exactly one place.
	 */
	holdsIndex(databasePath: string): boolean {
		try {
			return readdirSync(databasePath).some((e) =>
				ProjectMetadataStore.MARKERS.has(e),
			);
		} catch {
			return false;
		}
	}
}
