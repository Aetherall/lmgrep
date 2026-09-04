import { createHash } from "node:crypto";

/**
 * A model string in `provider:model` form, the family comparison that decides
 * whether two models produce interchangeable embeddings, and the directory
 * slug derived from it.
 *
 * Only the family matters: a re-quantized or re-tagged build of the same model
 * produces compatible embeddings, and so does the same model served by a
 * different runtime, so comparing raw strings would partition on differences
 * that do not exist.
 *
 * The slug is the load-bearing part. Databases are stored per model, so
 * {@link toSlug} draws the boundary between them — and it must draw it in
 * exactly the same place as {@link isSameFamilyAs}. Two models share a
 * database if and only if they are compatible; a slug that split more finely
 * would re-embed a corpus for nothing, and one that split more coarsely would
 * mix incomparable vectors into one table.
 */
export class ModelIdentity {
	/** Quantization and tag suffixes that do not change the embedding space. */
	private static readonly VARIANT_SUFFIX =
		/^(Q\d|q\d|fp\d|f\d|latest|gguf|ggml)/i;

	/** Long enough to stay readable in a path, short enough to stay a path. */
	private static readonly SLUG_PREFIX_LENGTH = 48;
	private static readonly SLUG_HASH_LENGTH = 8;

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
		const suffix = lastColon === -1 ? "" : rest.slice(lastColon + 1);
		const family =
			lastColon !== -1 && ModelIdentity.VARIANT_SUFFIX.test(suffix)
				? rest.slice(0, lastColon)
				: rest;
		return family.replace(
			/^(?:docker\.io\/(?:ai|library)\/|docker\.io\/|huggingface\.co\/)/i,
			"",
		);
	}

	/** Whether two models produce interchangeable embeddings. */
	isSameFamilyAs(other: ModelIdentity): boolean {
		return this.family === other.family;
	}

	/**
	 * Directory name holding this model's embeddings.
	 *
	 * Built from the family rather than the full string, so switching runtimes
	 * (`ollama:` to `lmstudio:`) or pulling a new quantization reuses the index
	 * instead of silently re-embedding the repository.
	 *
	 * `dimensions` is part of the identity because a model with configurable
	 * output width produces vectors that cannot be compared across widths —
	 * same family, different space. It is the one axis {@link isSameFamilyAs}
	 * cannot see, so it is folded in here.
	 *
	 * The trailing hash is what actually guarantees uniqueness: the readable
	 * prefix is truncated, sanitized, and compared case-insensitively by macOS
	 * and Windows filesystems, so it cannot be relied on to separate two
	 * models on its own.
	 */
	toSlug(dimensions?: number): string {
		const identity = dimensions ? `${this.family}@${dimensions}` : this.family;
		const hash = createHash("sha256")
			.update(identity)
			.digest("hex")
			.slice(0, ModelIdentity.SLUG_HASH_LENGTH);
		const readable = this.family
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, ModelIdentity.SLUG_PREFIX_LENGTH);
		return readable.length > 0 ? `${readable}-${hash}` : hash;
	}
}
