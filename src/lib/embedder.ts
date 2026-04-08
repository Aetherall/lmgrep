import { embed, embedMany, type EmbeddingModel } from "ai";
import { createProviderRegistry } from "ai";
import { importProvider } from "./providers.js";
import type { LmgrepConfig } from "./types.js";

export interface Embedder {
	embed(texts: string[]): Promise<number[][]>;
	embedQuery(query: string): Promise<number[]>;
}

export interface EmbedderEvents {
	onBatchStart?: (batchNum: number, totalBatches: number) => void;
	onBatchDone?: (batchNum: number, succeeded: number, failed: number) => void;
	onReload?: (attempt: number, maxAttempts: number) => void;
}

/**
 * Thrown when too many consecutive embedding batches fail.
 * The caller should persist any successful chunks before surfacing this error.
 */
export class EmbeddingAbortError extends Error {
	constructor(
		public readonly vectors: (number[] | null)[],
		public readonly failedIndices: Set<number>,
		public readonly total: number,
	) {
		const succeeded = vectors.filter((v) => v !== null).length;
		super(
			`Embedding aborted after ${failedIndices.size} failures. ` +
				`${succeeded}/${total} chunks embedded successfully. ` +
				`Check your embedding provider and run \`lmgrep index\` to resume.`,
		);
		this.name = "EmbeddingAbortError";
	}
}

interface AISDKEmbedderConfig {
	model: string;
	provider?: string;
	baseURL?: string;
	batchSize: number;
	dimensions?: number;
	queryPrefix?: string;
	documentPrefix?: string;
	maxTokens?: number;
}

export class AISDKEmbedder implements Embedder {
	private cachedModel: EmbeddingModel | undefined;
	private config: AISDKEmbedderConfig;
	private validated = false;

	constructor(config: LmgrepConfig) {
		this.config = config;
	}

	private validateDimension(vector: number[]): void {
		if (this.validated) return;
		this.validated = true;
		if (
			this.config.dimensions != null &&
			vector.length !== this.config.dimensions
		) {
			throw new Error(
				`Embedding dimension mismatch: expected ${this.config.dimensions}, got ${vector.length}. Check your model and config.dimensions.`,
			);
		}
	}

	private async getModel(): Promise<EmbeddingModel> {
		if (this.cachedModel) return this.cachedModel;

		const colonIdx = this.config.model.indexOf(":");
		if (colonIdx === -1) {
			throw new Error(
				`Model must be in "provider:model" format. Got: "${this.config.model}"`,
			);
		}

		const providerName = this.config.model.slice(0, colonIdx);
		const pkg = this.config.provider ?? `@ai-sdk/${providerName}`;
		const providerModule = await importProvider(pkg);

		let providerInstance = providerModule[providerName];

		if (!providerInstance) {
			const factoryKey = Object.keys(providerModule).find((k) =>
				k.startsWith("create"),
			);
			if (factoryKey) {
				const factory = providerModule[factoryKey] as (
					opts: Record<string, unknown>,
				) => unknown;
				providerInstance = factory({
					name: providerName,
					...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
				});
			}
		}

		if (!providerInstance) {
			throw new Error(
				`Package "${pkg}" has no usable provider export. Available: ${Object.keys(providerModule).join(", ")}`,
			);
		}

		const registry = createProviderRegistry({
			[providerName]: providerInstance,
		} as Record<string, never>);

		this.cachedModel = registry.embeddingModel(
			this.config.model as `${string}:${string}`,
		) as EmbeddingModel;
		return this.cachedModel;
	}

	async embed(texts: string[]): Promise<number[][]> {
		const model = await this.getModel();
		const prefix = this.config.documentPrefix ?? "";
		const allEmbeddings: number[][] = [];

		for (let i = 0; i < texts.length; i += this.config.batchSize) {
			const batch = texts.slice(i, i + this.config.batchSize);
			const values = prefix ? batch.map((t) => prefix + t) : batch;
			const { embeddings } = await embedMany({ model, values });
			if (embeddings.length > 0) this.validateDimension(embeddings[0]);
			allEmbeddings.push(...embeddings);
		}

		return allEmbeddings;
	}

	async embedQuery(query: string): Promise<number[]> {
		const model = await this.getModel();
		const prefix = this.config.queryPrefix ?? "";
		const { embedding } = await embed({ model, value: prefix + query });
		this.validateDimension(embedding);
		return embedding;
	}
}

/**
 * Resilient embedder that retries failed batches individually.
 * On too many consecutive failures, throws EmbeddingAbortError so the caller
 * can persist partial progress and exit cleanly.
 *
 * For local LM Studio setups with baseURL set to localhost, it will attempt
 * to reload the model before aborting.
 */
export class ResilientEmbedder {
	private consecutiveFailures = 0;
	private reloads = 0;
	private readonly isLocal: boolean;

	constructor(
		private embedder: Embedder,
		private config: LmgrepConfig,
		private events?: EmbedderEvents,
	) {
		this.isLocal = isLocalProvider(config.baseURL);
	}

	private static readonly BATCH_DELAY_MS = 200;
	private static readonly MAX_CONSECUTIVE_FAILURES = 3;
	private static readonly MAX_RELOADS = 3;

	async embedBatched(
		texts: string[],
	): Promise<{ vectors: (number[] | null)[]; failedIndices: Set<number> }> {
		const batchSize = this.config.batchSize;
		const vectors: (number[] | null)[] = new Array(texts.length).fill(null);
		const failedIndices = new Set<number>();
		const totalBatches = Math.ceil(texts.length / batchSize);

		for (let i = 0; i < texts.length; i += batchSize) {
			const batchNum = Math.floor(i / batchSize) + 1;
			const end = Math.min(i + batchSize, texts.length);
			const batch = texts.slice(i, end);

			this.events?.onBatchStart?.(batchNum, totalBatches);

			try {
				const batchVectors = await this.embedder.embed(batch);
				for (let j = 0; j < batch.length; j++) {
					vectors[i + j] = batchVectors[j];
				}
				this.consecutiveFailures = 0;
			} catch {
				// Batch failed — retry individually
				let batchFailed = 0;
				for (let j = 0; j < batch.length; j++) {
					try {
						const [vec] = await this.embedder.embed([batch[j]]);
						vectors[i + j] = vec;
					} catch (err) {
						failedIndices.add(i + j);
						batchFailed++;
						console.error(
							`  ! Failed (~${Math.ceil(batch[j].length / 4)} tok): ${err instanceof Error ? err.message : err}`,
						);
					}
				}

				if (batchFailed === batch.length) {
					this.consecutiveFailures++;
				} else {
					this.consecutiveFailures = 0;
				}
			}

			const succeeded = vectors.filter((v) => v !== null).length;
			this.events?.onBatchDone?.(batchNum, succeeded, failedIndices.size);

			// Handle consecutive failures
			if (
				this.consecutiveFailures >=
				ResilientEmbedder.MAX_CONSECUTIVE_FAILURES
			) {
				// For local providers, try reloading the model
				if (this.isLocal && this.reloads < ResilientEmbedder.MAX_RELOADS) {
					this.reloads++;
					this.events?.onReload?.(
						this.reloads,
						ResilientEmbedder.MAX_RELOADS,
					);
					const ok = await this.reloadModel();
					if (ok) {
						this.consecutiveFailures = 0;
						i -= ResilientEmbedder.MAX_CONSECUTIVE_FAILURES * batchSize;
						continue;
					}
				}

				// Mark remaining as failed
				for (let k = end; k < texts.length; k++) {
					failedIndices.add(k);
				}

				// Abort — carry partial results so the caller can persist them
				throw new EmbeddingAbortError(
					vectors,
					failedIndices,
					texts.length,
				);
			}

			// Cooldown between batches
			if (end < texts.length) {
				await new Promise((r) =>
					setTimeout(r, ResilientEmbedder.BATCH_DELAY_MS),
				);
			}
		}

		return { vectors, failedIndices };
	}

	private async reloadModel(): Promise<boolean> {
		const modelId = this.config.model.split(":").slice(1).join(":");
		const baseURL = this.config.baseURL ?? "http://localhost:1234";
		const apiBase = baseURL.replace(/\/v1\/?$/, "");

		try {
			await fetch(`${apiBase}/api/v1/models/unload`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ instance_id: modelId }),
			});
			await new Promise((r) => setTimeout(r, 2000));
			const res = await fetch(`${apiBase}/api/v1/models/load`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: modelId,
					context_length: this.config.maxTokens ?? 8192,
				}),
			});
			await res.json();
			return true;
		} catch {
			return false;
		}
	}
}

function isLocalProvider(baseURL?: string): boolean {
	if (!baseURL) return false;
	try {
		const host = new URL(baseURL).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
	} catch {
		return false;
	}
}
