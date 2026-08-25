import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";
import type { Vector } from "../../domain/faceting/Vector.js";
import type { EmbedderPort } from "../../domain/ports/EmbedderPort.js";
import { EmbeddingAbortError } from "./EmbeddingAbortError.js";

/** One successfully embedded item, keyed by its position in the input. */
export interface EmbeddedItem {
	index: number;
	vector: Vector;
}

export interface EmbeddingProgress {
	onBatchStart?(batchNumber: number, totalBatches: number): void;
	onBatchDone?(batchNumber: number, succeeded: number, failed: number): void;
	onReload?(attempt: number, max: number): void;
}

/**
 * Embeds a list of texts batch by batch, surviving a flaky provider.
 *
 * Three behaviours matter here and are easy to lose:
 *
 *  - **Incremental persistence.** Each batch is handed to `persist` before the
 *    next starts, so a crash leaves completed work in the index and a resume
 *    skips it. Nothing is buffered for the caller to write at the end.
 *  - **Per-item retry.** A failed batch is retried one item at a time, so a
 *    single oversized chunk cannot cost the other 99 in its batch.
 *  - **Model reload.** A local provider that has fallen over is given a chance
 *    to reload, and the failed span is replayed rather than abandoned.
 */
export class EmbeddingPipeline {
	private static readonly BATCH_DELAY_MS = 200;
	private static readonly MAX_CONSECUTIVE_FAILURES = 3;
	private static readonly MAX_RELOADS = 3;

	private consecutiveFailures = 0;
	private reloads = 0;

	constructor(
		private readonly embedder: EmbedderPort,
		private readonly config: LmgrepConfig,
		private readonly progress: EmbeddingProgress = {},
		/** Reloads a local model; returns false when it cannot be done. */
		private readonly reloadModel: () => Promise<boolean> = async () => false,
		/** Whether the provider is local, and therefore reloadable. */
		private readonly isLocal = false,
	) {}

	/**
	 * Returns the positions that could not be embedded. Successes are reported
	 * through `persist` exactly once each, never returned in bulk.
	 */
	async run(
		texts: string[],
		persist: (items: EmbeddedItem[]) => Promise<void>,
	): Promise<{ failedIndices: Set<number> }> {
		const batchSize = this.config.batchSize;
		const failedIndices = new Set<number>();
		const totalBatches = Math.ceil(texts.length / batchSize);

		// One byte per text to remember which positions have embedded, rather
		// than retaining the embeddings: `persist` already stored them and no
		// caller reads them back. At high dimensions a retained vector is tens
		// of KB, so a large repo would buffer gigabytes for a progress count.
		//
		// A flag array rather than a counter because the reload path below
		// rewinds and replays batches; flags keep the count idempotent.
		const succeededFlags = new Uint8Array(texts.length);
		let succeededCount = 0;
		const markSucceeded = (index: number): void => {
			if (succeededFlags[index]) return;
			succeededFlags[index] = 1;
			succeededCount++;
		};

		for (let i = 0; i < texts.length; i += batchSize) {
			const batchNumber = Math.floor(i / batchSize) + 1;
			const end = Math.min(i + batchSize, texts.length);
			const batch = texts.slice(i, end);

			this.progress.onBatchStart?.(batchNumber, totalBatches);

			const embedded: EmbeddedItem[] = [];
			try {
				const vectors = await this.embedder.embedDocuments(batch);
				for (let j = 0; j < batch.length; j++) {
					markSucceeded(i + j);
					embedded.push({ index: i + j, vector: vectors[j] });
				}
				this.consecutiveFailures = 0;
			} catch {
				const batchFailures = await this.retryIndividually(
					batch,
					i,
					embedded,
					failedIndices,
					markSucceeded,
				);
				this.consecutiveFailures =
					batchFailures === batch.length ? this.consecutiveFailures + 1 : 0;
			}

			// Persist before any abort below, so partial progress is durable
			// even when the next batches force one.
			if (embedded.length > 0) await persist(embedded);

			this.progress.onBatchDone?.(
				batchNumber,
				succeededCount,
				failedIndices.size,
			);

			if (
				this.consecutiveFailures >= EmbeddingPipeline.MAX_CONSECUTIVE_FAILURES
			) {
				const rewound = await this.tryReload(i, batchSize);
				if (rewound !== undefined) {
					i = rewound;
					continue;
				}

				for (let k = end; k < texts.length; k++) failedIndices.add(k);
				throw new EmbeddingAbortError(
					succeededCount,
					failedIndices,
					texts.length,
				);
			}

			// Brief cooldown so a local server is not hammered back over.
			if (end < texts.length) {
				await new Promise((r) =>
					setTimeout(r, EmbeddingPipeline.BATCH_DELAY_MS),
				);
			}
		}

		return { failedIndices };
	}

	/** Retry a failed batch item by item; returns how many still failed. */
	private async retryIndividually(
		batch: string[],
		offset: number,
		embedded: EmbeddedItem[],
		failedIndices: Set<number>,
		markSucceeded: (index: number) => void,
	): Promise<number> {
		let failures = 0;
		for (let j = 0; j < batch.length; j++) {
			try {
				const [vector] = await this.embedder.embedDocuments([batch[j]]);
				markSucceeded(offset + j);
				embedded.push({ index: offset + j, vector });
			} catch (err) {
				failedIndices.add(offset + j);
				failures++;
				console.error(
					`  ! Failed (~${Math.ceil(batch[j].length / 4)} tok): ` +
						`${err instanceof Error ? err.message : err}`,
				);
			}
		}
		return failures;
	}

	/**
	 * Give a local model a chance to come back, and return the loop position to
	 * rewind to. Undefined means give up.
	 */
	private async tryReload(
		current: number,
		batchSize: number,
	): Promise<number | undefined> {
		if (!this.isLocal) return undefined;
		if (this.reloads >= EmbeddingPipeline.MAX_RELOADS) return undefined;

		this.reloads++;
		this.progress.onReload?.(this.reloads, EmbeddingPipeline.MAX_RELOADS);
		if (!(await this.reloadModel())) return undefined;

		this.consecutiveFailures = 0;
		// Replay the span that failed. Already-persisted positions are marked,
		// so re-embedding them cannot double-count. Clamped at zero: rewinding
		// past the start would hand `slice` a negative index, which counts from
		// the end and would replay the wrong texts.
		return Math.max(
			0,
			current - EmbeddingPipeline.MAX_CONSECUTIVE_FAILURES * batchSize,
		);
	}
}
