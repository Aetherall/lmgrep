/**
 * A model string in `provider:model` form, and the family comparison used to
 * warn when an index is searched with a different model than built it.
 *
 * Only the family matters for that warning: a re-quantized or re-tagged build
 * of the same model produces compatible embeddings, so comparing the raw
 * strings would cry wolf on every tag change.
 */
export class ModelIdentity {
	/** Quantization and tag suffixes that do not change the embedding space. */
	private static readonly VARIANT_SUFFIX =
		/^(Q\d|q\d|fp\d|f\d|latest|gguf|ggml)/i;

	private constructor(private readonly value: string) {}

	static of(model: string): ModelIdentity {
		return new ModelIdentity(model);
	}

	toString(): string {
		return this.value;
	}

	/** Provider segment, or undefined when the string carries none. */
	get provider(): string | undefined {
		const colon = this.value.indexOf(":");
		return colon === -1 ? undefined : this.value.slice(0, colon);
	}

	/**
	 * The model name with the provider prefix and any variant suffix removed.
	 *
	 *   "openai:nomic-embed-text"        -> "nomic-embed-text"
	 *   "ollama:nomic-embed-text:Q4_K_M" -> "nomic-embed-text"
	 *   "lmstudio:bge-large-en:fp16"     -> "bge-large-en"
	 */
	get family(): string {
		const colon = this.value.indexOf(":");
		if (colon === -1) return this.value;
		const rest = this.value.slice(colon + 1);

		const lastColon = rest.lastIndexOf(":");
		if (lastColon === -1) return rest;

		const suffix = rest.slice(lastColon + 1);
		if (ModelIdentity.VARIANT_SUFFIX.test(suffix)) {
			return rest.slice(0, lastColon);
		}
		// Unrecognized trailing segment — likely part of the name itself.
		return rest;
	}

	/** Whether two models produce interchangeable embeddings. */
	isSameFamilyAs(other: ModelIdentity): boolean {
		return this.family === other.family;
	}
}
