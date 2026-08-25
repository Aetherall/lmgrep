import type { FileManifest } from "../../domain/corpus/SourceFile.js";
import type { WorkspacePort } from "../../domain/ports/WorkspacePort.js";

/** How the working tree differs from what the manifest recorded. */
export interface TreeChanges {
	added: string[];
	modified: string[];
	deleted: string[];
}

/**
 * Compares the working tree against the manifest, without changing anything.
 *
 * This is what `lmgrep status --changes` reports: a read-only preview of what
 * the next index run would do, so a user can see whether it is worth running.
 */
export class WorkingTreeDiff {
	constructor(private readonly workspace: WorkspacePort) {}

	compute(projectRoot: string, manifest: FileManifest): TreeChanges {
		const added: string[] = [];
		const modified: string[] = [];
		const deleted: string[] = [];
		const seen = new Set<string>();

		for (const file of this.workspace.listFiles(projectRoot)) {
			seen.add(file);
			const hash = this.workspace.hashOf(projectRoot, file);
			// Unreadable right now: not a reportable change either way.
			if (!hash) continue;

			const stored = manifest.versionOf(file);
			if (!stored) added.push(file);
			else if (!stored.equals(hash)) modified.push(file);
		}

		for (const path of manifest.paths()) {
			if (!seen.has(path)) deleted.push(path);
		}

		return { added, modified, deleted };
	}
}
