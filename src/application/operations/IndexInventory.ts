import { existsSync } from "node:fs";
import type { IndexMetadataPort } from "../../domain/ports/IndexMetadataPort.js";
import type { ProjectRegistryPort } from "../../domain/ports/ProjectRegistryPort.js";
import type { StateDirectoryPort } from "../../domain/ports/StateDirectoryPort.js";

/** One index on this machine, and what is known about it. */
export interface InventoryEntry {
	databasePath: string;
	/** Working tree it describes, when that is recorded. */
	root?: string;
	/** Name of a standalone index, which is its identity instead of a root. */
	name?: string;
	remote?: string;
	model?: string;
	dimensions?: number;
	indexedAt?: string;
	bytes: number;
	/** Whether the working tree it describes still exists. */
	rootExists: boolean;
	/**
	 * `repository` — inside the repo it indexes, the current scheme.
	 * `standalone` — in the state directory, for corpora with no repo.
	 * `legacy`     — written by a version that kept every index in the state
	 *                directory; readable, adoptable, removable.
	 */
	kind: "repository" | "standalone" | "legacy";
}

export interface Inventory {
	entries: InventoryEntry[];
	/** Registry entries whose database is gone: pointers to nothing. */
	dangling: number;
	totalBytes: number;
}

/**
 * The list of every index this machine holds.
 *
 * This exists because indexes stopped being enumerable by listing a directory.
 * That was the point — an index inside its repository cannot be orphaned by
 * deleting the repository — but it removed the only way anyone could see what
 * lmgrep had accumulated. Before this, an install could hold a hundred
 * databases and many gigabytes with no command that would say so, and the only
 * thing that could enumerate them was an MCP tool the user could not call.
 */
export class IndexInventory {
	constructor(
		private readonly registry: ProjectRegistryPort,
		private readonly metadata: IndexMetadataPort,
		private readonly state: StateDirectoryPort,
		private readonly sizeOf: (path: string) => number,
	) {}

	collect(): Inventory {
		const entries: InventoryEntry[] = [];
		const seen = new Set<string>();

		for (const registered of this.registry.list()) {
			seen.add(registered.databasePath);
			entries.push({
				databasePath: registered.databasePath,
				root: registered.root,
				name: registered.name,
				remote: registered.remote,
				model: registered.model,
				dimensions: registered.dimensions,
				indexedAt: registered.indexedAt,
				bytes: this.sizeOf(registered.databasePath),
				// A standalone index outlives the directory it was built from,
				// so its project cannot be "gone" — collecting it on that
				// basis would delete a corpus that is working fine.
				rootExists: registered.name ? true : existsSync(registered.root),
				kind: this.kindOf(registered.databasePath),
			});
		}

		for (const path of this.state.legacyDatabaseDirectories()) {
			if (seen.has(path)) continue;
			const meta = this.metadata.read(path);
			entries.push({
				databasePath: path,
				root: meta?.root,
				remote: meta?.remote,
				model: meta?.model,
				dimensions: meta?.dimensions,
				indexedAt: meta?.indexedAt,
				bytes: this.sizeOf(path),
				rootExists: meta?.root ? existsSync(meta.root) : false,
				kind: "legacy",
			});
		}

		entries.sort((a, b) => b.bytes - a.bytes);
		return {
			entries,
			dangling: this.registry.dangling().length,
			totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
		};
	}

	/**
	 * Where an index lives. Decided by path rather than by a stored flag, so an
	 * entry written by any version reports the truth about where it is now.
	 */
	private kindOf(databasePath: string): InventoryEntry["kind"] {
		return databasePath.startsWith(this.state.databasesDirectory())
			? "standalone"
			: "repository";
	}
}
