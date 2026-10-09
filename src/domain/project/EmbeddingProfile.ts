import { createHash } from "node:crypto";
import type { LmgrepConfig } from "../config/LmgrepConfig.js";
import { ModelIdentity } from "./ModelIdentity.js";

export interface EmbeddingProfileData {
	artifact: string;
	dimensions?: number;
	/**
	 * Recorded for reference only. It is applied to search text, never to the
	 * stored vectors, so it is not part of the index identity.
	 */
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
		return this.data.artifact === other.artifact && this.sameSettingsAs(other);
	}

	/**
	 * The warning for importing `other` into this profile when they differ only
	 * by artifact digest and the model names share a family, or undefined when
	 * that does not hold. Re-pulling a tag can change the digest without
	 * changing the weights, so imports accept this case instead of refusing.
	 */
	artifactDriftWarning(
		other: EmbeddingProfileData,
		model?: string,
		otherModel?: string,
	): string | undefined {
		if (
			this.data.artifact === other.artifact ||
			!this.sameSettingsAs(other) ||
			!model ||
			!otherModel ||
			!ModelIdentity.of(model).isSameFamilyAs(ModelIdentity.of(otherModel))
		) {
			return undefined;
		}
		return (
			`Warning: source index was built with ${other.artifact}, ` +
			`but "${model}" resolves to ${this.data.artifact} here. ` +
			"Importing anyway since the model name and embedding settings match; " +
			"if search results look off, pull the same model version as the source."
		);
	}

	private sameSettingsAs(other: EmbeddingProfileData): boolean {
		return (
			this.data.dimensions === other.dimensions &&
			this.data.documentPrefix === other.documentPrefix
		);
	}

	toSlug(): string {
		const { artifact, dimensions, documentPrefix } = this.data;
		const hash = createHash("sha256")
			.update(JSON.stringify([artifact, dimensions ?? null, documentPrefix]))
			.digest("hex");
		return `embedding-${hash}`;
	}
}
