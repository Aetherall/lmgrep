import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { IndexMetadataPort } from "../../domain/ports/IndexMetadataPort.js";
import type { IndexPathPort } from "../../domain/ports/IndexPathPort.js";
import type { EmbeddingProfile } from "../../domain/project/EmbeddingProfile.js";

export class VerifiedIndexPath implements IndexPathPort {
	constructor(
		private readonly profile: EmbeddingProfile,
		private readonly metadata: IndexMetadataPort,
	) {}

	resolve(indexHome: string): string {
		const preferred = join(indexHome, this.profile.toSlug());
		if (this.metadata.holdsIndex(preferred)) {
			const recorded = this.metadata.read(preferred)?.embeddingProfile;
			if (!recorded || !this.profile.equals(recorded)) {
				throw new Error(
					`Cannot verify embedding settings for index at ${preferred}. Existing index was not changed.`,
				);
			}
			return preferred;
		}
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(indexHome, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return preferred;
			throw error;
		}
		const matches = entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(indexHome, entry.name))
			.filter((path) => {
				const recorded = this.metadata.read(path)?.embeddingProfile;
				return recorded && this.profile.equals(recorded);
			})
			.sort();
		if (matches.length > 1) {
			throw new Error(
				`Multiple verified indexes match this model: ${matches.join(", ")}. Select one explicitly with --in <path>.`,
			);
		}
		return matches[0] ?? preferred;
	}
}
