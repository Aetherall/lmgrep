import { createHash } from "node:crypto";
import type { LmgrepConfig } from "../config/LmgrepConfig.js";

export interface EmbeddingProfileData {
	artifact: string;
	dimensions?: number;
	queryPrefix: string;
	documentPrefix: string;
}

export class EmbeddingProfile {
	constructor(readonly data: EmbeddingProfileData) {}

	static forArtifact(artifact: string, config: LmgrepConfig): EmbeddingProfile {
		return new EmbeddingProfile({
			artifact,
			dimensions: config.dimensions,
			queryPrefix: config.queryPrefix ?? "",
			documentPrefix: config.documentPrefix ?? "",
		});
	}

	equals(other: EmbeddingProfileData): boolean {
		return (
			this.data.artifact === other.artifact &&
			this.data.dimensions === other.dimensions &&
			this.data.queryPrefix === other.queryPrefix &&
			this.data.documentPrefix === other.documentPrefix
		);
	}

	toSlug(): string {
		const { artifact, dimensions, queryPrefix, documentPrefix } = this.data;
		const hash = createHash("sha256")
			.update(
				JSON.stringify([
					artifact,
					dimensions ?? null,
					queryPrefix,
					documentPrefix,
				]),
			)
			.digest("hex");
		return `embedding-${hash}`;
	}
}
