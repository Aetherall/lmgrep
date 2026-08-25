import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";
import type { Chunk } from "../../domain/corpus/Chunk.js";
import type { ContentHash } from "../../domain/corpus/ContentHash.js";
import { FileVersion } from "../../domain/corpus/FileVersion.js";
import type { SourceFile } from "../../domain/corpus/SourceFile.js";
import type {
	ChunkRepositoryPort,
	EmbeddedChunk,
} from "../../domain/ports/ChunkRepositoryPort.js";
import type { ChunkerPort } from "../../domain/ports/ChunkerPort.js";
import type { EmbedderPort } from "../../domain/ports/EmbedderPort.js";
import type { FileManifestRepositoryPort } from "../../domain/ports/FileManifestRepositoryPort.js";
import type { IndexMaintenancePort } from "../../domain/ports/IndexMaintenancePort.js";
import type { LoggerPort } from "../../domain/ports/LoggerPort.js";
import type { WorkspacePort } from "../../domain/ports/WorkspacePort.js";
import type { Vector } from "../../domain/faceting/Vector.js";
import type { DatabaseLocation } from "../../domain/project/DatabaseLocation.js";
import type { BranchBootstrapper } from "./BranchBootstrapper.js";
import type { BranchManifestSweeper } from "./BranchManifestSweeper.js";
import { Duration } from "./Duration.js";
import { EmbeddingAbortError } from "./EmbeddingAbortError.js";
import { EmbeddingPipeline } from "./EmbeddingPipeline.js";
import type {
	IndexBuildOptions,
	IndexBuildResult,
} from "./IndexingProgress.js";
import type { VocabularyBuilder } from "./VocabularyBuilder.js";

/** Everything the builder collaborates with, named so wiring stays readable. */
export interface IndexBuilderDependencies {
	workspace: WorkspacePort;
	chunker: ChunkerPort;
	embedder: EmbedderPort;
	chunks: ChunkRepositoryPort;
	manifest: FileManifestRepositoryPort;
	maintenance: IndexMaintenancePort;
	vocabulary: VocabularyBuilder;
	bootstrapper: BranchBootstrapper;
	sweeper: BranchManifestSweeper;
	logger: LoggerPort;
	config: LmgrepConfig;
	location: DatabaseLocation;
	/** Records the model and dimensions this run indexed with. */
	recordMetadata: (dimensions: number | undefined) => void;
	/** Reloads a wedged local model mid-run; false when not possible. */
	reloadModel: () => Promise<boolean>;
	isLocalProvider: boolean;
}

/**
 * Turns a working tree into an index.
 *
 * The order of operations is what makes a run resumable after a crash: a
 * file's manifest entry is written only once every one of its chunks is
 * embedded *and* persisted. A hard stop therefore leaves completed files
 * marked done (a resume skips them) and in-flight files unmarked (a resume
 * re-embeds them cleanly, after dropping their partial chunks).
 */
export class IndexBuilder {
	constructor(private readonly deps: IndexBuilderDependencies) {}

	async build(options: IndexBuildOptions = {}): Promise<IndexBuildResult> {
		const { logger } = this.deps;

		if (options.reset) {
			logger.info("Resetting index...");
			await this.deps.maintenance.reset();
		} else {
			await this.deps.bootstrapper.bootstrap(this.deps.location.root);
		}

		const files = this.selectFiles(options);
		options.onProgress?.({
			phase: "scan",
			current: files.length,
			total: files.length,
		});

		const manifest = await this.deps.manifest.current();
		const { changed, current } = this.deps.workspace.detectChanges(
			files,
			manifest,
			this.deps.location.root,
			options.force,
		);
		logger.info(`${changed.length} files changed out of ${files.length}`);
		if (changed.length === 0) {
			logger.info("No changes detected. Index is up to date.");
			return { succeeded: 0, failed: 0 };
		}

		const fresh = await this.registerAlreadyKnownContent(changed);
		if (fresh.length === 0) {
			logger.info("No new content to index.");
			return { succeeded: 0, failed: 0 };
		}

		const chunks = await this.chunkAll(fresh, options);
		if (chunks.length === 0) {
			logger.info("No chunks produced. Index is up to date.");
			return { succeeded: 0, failed: 0 };
		}

		const changedPaths = fresh.map((f) => f.path);
		if (options.dry) {
			for (const path of changedPaths) logger.info(`  ${path}`);
			return { succeeded: 0, failed: 0 };
		}

		// Drop the previous version's chunks before writing the new ones, or
		// both versions would answer searches.
		await this.deps.chunks.deleteByFiles(changedPaths);

		const toEmbed = await this.selectChunksToEmbed(chunks, changedPaths);
		if (toEmbed.length === 0) {
			await this.commitFiles(changedPaths, current);
			logger.info("All chunks already indexed.");
			return { succeeded: 0, failed: 0 };
		}

		return this.embedAndStore(toEmbed, changedPaths, current, options);
	}

	private selectFiles(options: IndexBuildOptions): string[] {
		const { logger, workspace, config, location } = this.deps;

		if (options.files && options.files.length > 0) {
			logger.info(`Processing ${options.files.length} targeted files`);
			return options.files;
		}

		let files = workspace.listFiles(
			location.root,
			config.ignore,
			config.extensions,
		);

		if (options.since) {
			const cutoff = Duration.parse(options.since).agoFrom(Date.now());
			const before = files.length;
			files = workspace.modifiedSince(files, location.root, cutoff);
			logger.info(
				`Found ${files.length} files modified in the last ${options.since} (out of ${before})`,
			);
		} else {
			logger.info(`Found ${files.length} files`);
		}
		return files;
	}

	/**
	 * Register files whose content another branch already embedded, and return
	 * only those genuinely needing work.
	 *
	 * This is what makes branch switching cheap: chunks are content-addressed,
	 * so an identical file on another branch needs a manifest row, not a
	 * re-embed.
	 */
	private async registerAlreadyKnownContent(
		changed: SourceFile[],
	): Promise<SourceFile[]> {
		const known = await this.deps.manifest.knownHashes(
			changed.map((f) => f.hash),
		);

		const alreadyIndexed = changed.filter((f) => known.has(f.hash.toString()));
		const fresh = changed.filter((f) => !known.has(f.hash.toString()));

		if (alreadyIndexed.length > 0) {
			await this.deps.manifest.upsert(alreadyIndexed);
			this.deps.logger.info(
				`${alreadyIndexed.length} files already indexed (content known from other branches)`,
			);
		}
		return fresh;
	}

	private async chunkAll(
		files: SourceFile[],
		options: IndexBuildOptions,
	): Promise<Chunk[]> {
		const all: Chunk[] = [];

		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			try {
				const produced = await this.deps.chunker.chunk(
					file.path,
					this.deps.location.root,
				);
				// Stamp each chunk with its file's version so search can scope
				// to exactly the versions this branch references.
				const version = FileVersion.of(file.hash);
				for (const chunk of produced) all.push(chunk.stampedWith(version));
			} catch {
				// A file that fails to parse is skipped, not fatal — one bad
				// file must not abort a whole index run.
			}

			if ((i + 1) % 1000 === 0 || i === files.length - 1) {
				options.onProgress?.({
					phase: "chunk",
					current: i + 1,
					total: files.length,
					message: `${all.length} chunks`,
				});
				this.deps.logger.info(
					`Chunking: ${i + 1}/${files.length} files, ${all.length} chunks so far`,
				);
			}
		}
		return all;
	}

	/** Drop chunks already embedded, then any the provider would reject. */
	private async selectChunksToEmbed(
		chunks: Chunk[],
		changedPaths: string[],
	): Promise<Chunk[]> {
		const existing = await this.deps.chunks.existingHashes(
			chunks.map((c) => c.hash),
		);
		let candidates = chunks.filter(
			(c) => !existing.has(c.hash.toString()),
		);
		const alreadyIndexed = chunks.length - candidates.length;

		let oversized = 0;
		const maxTokens = this.deps.config.maxTokens;
		if (maxTokens) {
			const before = candidates.length;
			candidates = candidates.filter(
				(c) => c.estimatedTokens() <= maxTokens,
			);
			oversized = before - candidates.length;
		}

		this.deps.logger.info(
			`${changedPaths.length} files changed, ${chunks.length} chunks total, ` +
				`${candidates.length} to embed (${alreadyIndexed} already indexed` +
				`${oversized > 0 ? `, ${oversized} oversized` : ""})`,
		);
		return candidates;
	}

	private async embedAndStore(
		chunks: Chunk[],
		changedPaths: string[],
		current: Map<string, ContentHash>,
		options: IndexBuildOptions,
	): Promise<IndexBuildResult> {
		const { logger } = this.deps;

		// Chunks still owed per file. A file commits only when this hits zero.
		const outstanding = new Map<string, number>();
		for (const c of chunks) {
			const path = c.location.filePath;
			outstanding.set(path, (outstanding.get(path) ?? 0) + 1);
		}

		let succeeded = 0;
		let stored = 0;
		let dimensions: number | undefined;
		const vocabSource: Array<{ name: string; content: string }> = [];

		const persist = async (
			items: Array<{ index: number; vector: Vector }>,
		): Promise<void> => {
			const embedded: EmbeddedChunk[] = items.map((it) => ({
				chunk: chunks[it.index],
				vector: it.vector,
			}));
			await this.deps.chunks.add(embedded);

			succeeded += embedded.length;
			stored += embedded.length;
			dimensions ??= embedded[0]?.vector.dimensions;
			if (options.reset) {
				for (const { chunk } of embedded) {
					vocabSource.push({ name: chunk.name, content: chunk.content });
				}
			}
			options.onProgress?.({
				phase: "store",
				current: stored,
				total: chunks.length,
			});

			await this.commitCompletedFiles(embedded, outstanding, current);
		};

		const pipeline = new EmbeddingPipeline(
			this.deps.embedder,
			this.deps.config,
			{
				onBatchStart: (n, total) =>
					options.onProgress?.({ phase: "embed", current: n, total }),
				onBatchDone: (n, ok, failed) =>
					logger.info(
						`Batch ${n}: ${ok} ok / ${failed} err / ${chunks.length} total`,
					),
				onReload: (attempt, max) =>
					logger.info(
						`Consecutive failures — reloading model (attempt ${attempt}/${max})...`,
					),
			},
			this.deps.reloadModel,
			this.deps.isLocalProvider,
		);

		let failedIndices: Set<number>;
		let aborted = false;
		try {
			({ failedIndices } = await pipeline.run(
				chunks.map((c) => c.embeddingText()),
				persist,
			));
		} catch (err) {
			if (!(err instanceof EmbeddingAbortError)) throw err;
			aborted = true;
			failedIndices = err.failedIndices;
			logger.error(err.message);
		}

		await this.commitUntouchedFiles(
			changedPaths,
			current,
			chunks,
			failedIndices,
			outstanding,
		);

		this.report(aborted, succeeded, failedIndices.size, changedPaths.length);

		if (options.reset && vocabSource.length > 0) {
			await this.deps.vocabulary.build(vocabSource);
		}

		this.deps.recordMetadata(dimensions);
		await this.deps.sweeper.sweep(this.deps.location.root);
		await this.runMaintenance(succeeded, options);

		return { succeeded, failed: failedIndices.size };
	}

	/** Commit files whose every chunk is now embedded and persisted. */
	private async commitCompletedFiles(
		embedded: EmbeddedChunk[],
		outstanding: Map<string, number>,
		current: Map<string, ContentHash>,
	): Promise<void> {
		const completed: SourceFile[] = [];
		for (const { chunk } of embedded) {
			const path = chunk.location.filePath;
			const left = (outstanding.get(path) ?? 0) - 1;
			outstanding.set(path, left);
			const hash = current.get(path);
			if (left === 0 && hash) {
				completed.push({ path, hash });
			}
		}
		if (completed.length > 0) await this.deps.manifest.upsert(completed);
	}

	/**
	 * Commit files that produced no new chunks at all — everything they held
	 * was already indexed, oversized, or unparseable — provided none of their
	 * chunks failed to embed.
	 */
	private async commitUntouchedFiles(
		changedPaths: string[],
		current: Map<string, ContentHash>,
		chunks: Chunk[],
		failedIndices: Set<number>,
		outstanding: Map<string, number>,
	): Promise<void> {
		const failedFiles = new Set<string>();
		for (const index of failedIndices) {
			failedFiles.add(chunks[index].location.filePath);
		}

		const remaining: SourceFile[] = [];
		for (const path of changedPaths) {
			const hash = current.get(path);
			if (!hash) continue;
			if (failedFiles.has(path)) continue;
			if ((outstanding.get(path) ?? 0) !== 0) continue;
			remaining.push({ path, hash });
		}
		if (remaining.length > 0) await this.deps.manifest.upsert(remaining);
	}

	private async commitFiles(
		paths: string[],
		current: Map<string, ContentHash>,
	): Promise<void> {
		const entries: SourceFile[] = [];
		for (const path of paths) {
			const hash = current.get(path);
			if (hash) entries.push({ path, hash });
		}
		if (entries.length > 0) await this.deps.manifest.upsert(entries);
	}

	private report(
		aborted: boolean,
		succeeded: number,
		failed: number,
		fileCount: number,
	): void {
		const { logger } = this.deps;
		if (aborted) {
			if (succeeded > 0) {
				logger.info(`Saved ${succeeded} chunks before aborting.`);
			}
			logger.info(
				`Embedding failed. ${failed} chunks could not be embedded. ` +
					"Fix your embedding provider and run `lmgrep index` to resume.",
			);
			return;
		}
		logger.info(
			`Done: ${succeeded} chunks indexed from ${fileCount} files` +
				(failed > 0 ? ` (${failed} failed)` : ""),
		);
	}

	/**
	 * Fold new rows into the ANN index and compact the fragments they landed
	 * in. No-ops while the unindexed tail is small, so a watcher's periodic
	 * reconcile does not churn. Never fatal: an unoptimized index is slow and
	 * memory-hungry, not wrong.
	 */
	private async runMaintenance(
		succeeded: number,
		options: IndexBuildOptions,
	): Promise<void> {
		if (succeeded === 0) return;
		try {
			const report = await this.deps.maintenance.optimize({
				create: options.createIndex ?? false,
			});
			for (const table of report.tables) {
				if (table.action === "created") {
					this.deps.logger.info(
						`Built vector index on ${table.table} (${table.rows} rows)`,
					);
				} else if (table.action === "optimized") {
					this.deps.logger.info(
						`Optimized ${table.table}: absorbed ${table.unindexed} unindexed rows`,
					);
				} else if (table.action === "needs-index") {
					this.deps.logger.info(
						`${table.table} has ${table.rows} rows and no vector index — ` +
							"searches scan every embedding. Run `lmgrep compact` to build one.",
					);
				}
			}
		} catch (err) {
			this.deps.logger.error(
				`Index optimization skipped: ${err instanceof Error ? err.message : err}`,
			);
		}
	}
}
