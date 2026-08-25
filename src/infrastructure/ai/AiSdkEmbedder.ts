import {
	createProviderRegistry,
	embed,
	embedMany,
	type EmbeddingModel,
} from "ai";
import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";
import { Vector } from "../../domain/faceting/Vector.js";
import type { EmbedderPort } from "../../domain/ports/EmbedderPort.js";
import { ModelReference, ProviderRegistry } from "./ProviderRegistry.js";

/**
 * Embeddings via the Vercel AI SDK.
 *
 * Documents and queries take different prefixes because asymmetric models
 * (nomic, e5, bge) are trained to expect them; omitting them degrades recall
 * without any visible error, so the distinction is enforced by having two
 * methods rather than one with a flag.
 */
export class AiSdkEmbedder implements EmbedderPort {
	private model: EmbeddingModel | undefined;
	private dimensionsChecked = false;

	constructor(
		private readonly config: LmgrepConfig,
		private readonly providers: ProviderRegistry = new ProviderRegistry(),
	) {}

	async embedDocuments(texts: string[]): Promise<Vector[]> {
		const model = await this.getModel();
		const prefix = this.config.documentPrefix ?? "";
		const out: Vector[] = [];

		// Sub-batch to the configured size: providers reject oversized requests,
		// and a local server will happily OOM on one.
		for (let i = 0; i < texts.length; i += this.config.batchSize) {
			const batch = texts.slice(i, i + this.config.batchSize);
			const values = prefix ? batch.map((t) => prefix + t) : batch;
			const { embeddings } = await embedMany({ model, values });
			if (embeddings.length > 0) this.verifyDimensions(embeddings[0]);
			for (const e of embeddings) out.push(Vector.from(e));
		}

		return out;
	}

	async embedQuery(query: string): Promise<Vector> {
		const model = await this.getModel();
		const prefix = this.config.queryPrefix ?? "";
		const { embedding } = await embed({ model, value: prefix + query });
		this.verifyDimensions(embedding);
		return Vector.from(embedding);
	}

	/**
	 * Check the configured width once, on the first embedding seen. A mismatch
	 * means the model is not the one the config describes, and every vector
	 * after this would be silently unusable against the index.
	 */
	private verifyDimensions(vector: number[]): void {
		if (this.dimensionsChecked) return;
		this.dimensionsChecked = true;
		if (
			this.config.dimensions != null &&
			vector.length !== this.config.dimensions
		) {
			throw new Error(
				`Embedding dimension mismatch: expected ${this.config.dimensions}, ` +
					`got ${vector.length}. Check your model and config.dimensions.`,
			);
		}
	}

	private async getModel(): Promise<EmbeddingModel> {
		if (this.model) return this.model;

		const reference = ModelReference.parse(this.config.model, "Model");
		const instance = await this.providers.instantiate({
			reference,
			packageName: this.config.provider,
			baseURL: this.config.baseURL,
			// Historically the embedding path only falls back to the factory
			// when there is no default export; see ProviderRequest.
			preferFactoryWhenBaseUrlSet: false,
		});

		const registry = createProviderRegistry({
			[reference.provider]: instance,
		} as Record<string, never>);

		this.model = registry.embeddingModel(
			reference.full as `${string}:${string}`,
		) as EmbeddingModel;
		return this.model;
	}
}
