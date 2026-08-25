import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { IndexMetadataPort } from "../../domain/ports/IndexMetadataPort.js";
import type {
	ProjectIndex,
	ProjectIndexesPort,
} from "../../domain/ports/ProjectIndexesPort.js";
import { DiskUsage } from "./DiskUsage.js";

/** ProjectIndexesPort over the index home directory. */
export class ProjectIndexes implements ProjectIndexesPort {
	constructor(private readonly metadata: IndexMetadataPort) {}

	list(indexHome: string): ProjectIndex[] {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(indexHome, { withFileTypes: true });
		} catch {
			return [];
		}

		const out: ProjectIndex[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const databasePath = join(indexHome, entry.name);
			const meta = this.metadata.read(databasePath);
			out.push({
				databasePath,
				model: meta?.model,
				dimensions: meta?.dimensions,
				indexedAt: meta?.indexedAt,
				bytes: DiskUsage.of(databasePath),
			});
		}
		return out.sort((a, b) => b.bytes - a.bytes);
	}
}
