import { execSync } from "node:child_process";
import {
	type Embedder,
	ResilientEmbedder,
	EmbeddingAbortError,
} from "./embedder.js";
import { walkFiles, detectChanges, filterByMtime } from "./scanner.js";
import { type Store, withWriteLock, writeProjectMetadata } from "./store.js";
import { tokenize } from "./vocab.js";
import type {
	Chunk,
	Chunker,
	IndexedChunk,
	Logger,
	LmgrepConfig,
	BuildOptions,
} from "./types.js";
import { consoleLogger } from "./types.js";

function gitCmd(cwd: string, ...args: string[]): string | undefined {
	try {
		return execSync(`git ${args.join(" ")}`, {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		})
			.toString()
			.trim();
	} catch {
		return undefined;
	}
}

function parseDuration(s: string): number {
	const match = s.match(/^(\d+)\s*(s|m|h|d)$/);
	if (!match)
		throw new Error(`Invalid duration "${s}". Use e.g. 10m, 2h, 1d`);
	const n = Number.parseInt(match[1], 10);
	const unit = match[2];
	const multipliers: Record<string, number> = {
		s: 1000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
	};
	return n * multipliers[unit];
}

export async function build(
	cwd: string,
	store: Store,
	config: LmgrepConfig,
	embedder: Embedder,
	chunker: Chunker,
	opts: BuildOptions = {},
	logger: Logger = consoleLogger,
): Promise<{ succeeded: number; failed: number }> {
	// Serialize writes across processes (the watcher plus any ad-hoc
	// `lmgrep index`) so concurrent indexers can't race into duplicate rows.
	return withWriteLock(store.path, () =>
		buildLocked(cwd, store, config, embedder, chunker, opts, logger),
	);
}

async function buildLocked(
	cwd: string,
	store: Store,
	config: LmgrepConfig,
	embedder: Embedder,
	chunker: Chunker,
	opts: BuildOptions = {},
	logger: Logger = consoleLogger,
): Promise<{ succeeded: number; failed: number }> {
	const log = logger.info.bind(logger);
	const emit = opts.onProgress;

	if (opts.reset) {
		log("Resetting index...");
		await store.reset();
	}

	// 0. Bootstrap new branch manifest from merge base
	if (!opts.reset) {
		const existingHashes = await store.getFileHashes();
		if (existingHashes.size === 0) {
			const storedBranches = await store.getStoredBranches();
			if (storedBranches.length > 0) {
				// Find the best source branch via merge-base
				let bestBranch: string | undefined;
				let bestScore = -1;
				for (const candidate of storedBranches) {
					const mergeBase = gitCmd(cwd, "merge-base", "HEAD", candidate);
					if (!mergeBase) continue;
					// Count commits between merge-base and HEAD — fewer = closer
					const ahead = gitCmd(cwd, "rev-list", "--count", `${mergeBase}..HEAD`);
					const distance = ahead ? Number.parseInt(ahead, 10) : Infinity;
					if (distance < Infinity && (bestBranch === undefined || distance < bestScore)) {
						bestBranch = candidate;
						bestScore = distance;
					}
				}

				if (bestBranch) {
					const copied = await store.copyBranchManifest(bestBranch);
					if (copied > 0) {
						log(`Bootstrapped from "${bestBranch}" manifest (${copied} files). Diffing changes...`);
					}
				}
			}
		}
	}

	// 1. Scan
	let files: string[];
	if (opts.files && opts.files.length > 0) {
		files = opts.files;
		log(`Processing ${files.length} targeted files`);
	} else {
		files = walkFiles(cwd, config.ignore, config.extensions);

		if (opts.since) {
			const cutoff = Date.now() - parseDuration(opts.since);
			const before = files.length;
			files = filterByMtime(files, cwd, cutoff);
			log(
				`Found ${files.length} files modified in the last ${opts.since} (out of ${before})`,
			);
		} else {
			log(`Found ${files.length} files`);
		}
	}

	emit?.({ phase: "scan", current: files.length, total: files.length });

	// 2. Change detection
	const storedHashes = await store.getFileHashes();
	const { changed, currentHashes } = detectChanges(
		files,
		storedHashes,
		cwd,
		opts.force,
	);

	log(`${changed.length} files changed out of ${files.length}`);

	if (changed.length === 0) {
		log("No changes detected. Index is up to date.");
		return { succeeded: 0, failed: 0 };
	}

	// 2b. Skip files whose content hash is already known (indexed on another branch)
	const knownHashes = await store.filterKnownFileHashes(
		changed.map((f) => f.hash),
	);
	const alreadyKnown: typeof changed = [];
	const trulyChanged: typeof changed = [];
	for (const f of changed) {
		if (knownHashes.has(f.hash)) {
			alreadyKnown.push(f);
		} else {
			trulyChanged.push(f);
		}
	}

	if (alreadyKnown.length > 0) {
		// Register these files on the current branch without re-chunking
		const hashEntries = alreadyKnown.map((f) => ({
			filePath: f.path,
			fileHash: f.hash,
		}));
		await store.upsertFileHashes(hashEntries);
		log(
			`${alreadyKnown.length} files already indexed (content known from other branches)`,
		);
	}

	if (trulyChanged.length === 0) {
		log("No new content to index.");
		return { succeeded: 0, failed: 0 };
	}

	// 3. Chunk changed files
	const changedPaths = trulyChanged.map((f) => f.path);
	// Stamp each chunk with its source file's version hash so search can scope
	// to the exact version a branch references (drops stale-version chunks).
	const pathFileHash = new Map(trulyChanged.map((f) => [f.path, f.hash]));
	const allChunks: Chunk[] = [];

	for (let i = 0; i < changedPaths.length; i++) {
		try {
			const chunks = await chunker.chunk(changedPaths[i], cwd);
			const fileHash = pathFileHash.get(changedPaths[i]);
			for (const c of chunks) c.fileHash = fileHash;
			allChunks.push(...chunks);
		} catch {
			// skip files that fail to parse
		}

		if ((i + 1) % 1000 === 0 || i === changedPaths.length - 1) {
			emit?.({
				phase: "chunk",
				current: i + 1,
				total: changedPaths.length,
				message: `${allChunks.length} chunks`,
			});
			log(
				`Chunking: ${i + 1}/${changedPaths.length} files, ${allChunks.length} chunks so far`,
			);
		}
	}

	if (allChunks.length === 0) {
		log("No chunks produced. Index is up to date.");
		return { succeeded: 0, failed: 0 };
	}

	if (opts.dry) {
		for (const f of changedPaths) log(`  ${f}`);
		return { succeeded: 0, failed: 0 };
	}

	// 4. Delete old chunks for changed files
	await store.deleteChunksByFiles(changedPaths);

	// 5. Filter out already-indexed chunks (by hash, queried in DB)
	const existingHashes = await store.filterExistingChunkHashes(
		allChunks.map((c) => c.hash),
	);
	let newChunks = allChunks.filter((c) => !existingHashes.has(c.hash));
	const alreadyIndexed = allChunks.length - newChunks.length;

	// Filter oversized chunks
	let skippedOversize = 0;
	if (config.maxTokens) {
		const before = newChunks.length;
		newChunks = newChunks.filter((c) => {
			const est = Math.ceil((c.context.length + c.content.length) / 4);
			return est <= config.maxTokens!;
		});
		skippedOversize = before - newChunks.length;
	}

	log(
		`${changedPaths.length} files changed, ${allChunks.length} chunks total, ${newChunks.length} to embed` +
			` (${alreadyIndexed} already indexed${skippedOversize > 0 ? `, ${skippedOversize} oversized` : ""})`,
	);

	if (newChunks.length === 0) {
		const hashEntries = changedPaths
			.filter((fp) => currentHashes.has(fp))
			.map((fp) => ({
				filePath: fp,
				fileHash: currentHashes.get(fp)!,
			}));
		if (hashEntries.length > 0) await store.upsertFileHashes(hashEntries);
		log("All chunks already indexed.");
		return { succeeded: 0, failed: 0 };
	}

	// 6. Embed and store
	const resilient = new ResilientEmbedder(embedder, config, {
		onBatchStart(batchNum, total) {
			emit?.({ phase: "embed", current: batchNum, total });
		},
		onBatchDone(batchNum, succeeded, failed) {
			log(
				`Batch ${batchNum}: ${succeeded} ok / ${failed} err / ${newChunks.length} total`,
			);
		},
		onReload(attempt, max) {
			log(
				`Consecutive failures — reloading model (attempt ${attempt}/${max})...`,
			);
		},
	});

	const texts = newChunks.map((c) => `${c.context}\n${c.content}`);

	// Per-file count of new chunks still to embed. A file's hash is committed
	// only once all of its new chunks are embedded AND persisted — so a hard
	// crash leaves completed files done (resume skips them) and in-flight files
	// uncommitted (resume re-embeds them cleanly after dropping partial chunks).
	const pendingByFile = new Map<string, number>();
	for (const c of newChunks) {
		pendingByFile.set(c.filePath, (pendingByFile.get(c.filePath) ?? 0) + 1);
	}

	let succeeded = 0;
	let storeProgress = 0;
	let embeddingDimensions: number | undefined;
	const vocabSource: Array<{ name: string; content: string }> = [];

	// Persist each batch's successes immediately, then commit any file whose
	// chunks are now fully embedded. Awaited inside embedBatched per batch.
	async function persistBatch(
		items: Array<{ index: number; vector: number[] }>,
	): Promise<void> {
		if (items.length === 0) return;

		const chunks: IndexedChunk[] = items.map((it) => ({
			...newChunks[it.index],
			vector: it.vector,
		}));
		await store.addChunks(chunks);

		succeeded += chunks.length;
		storeProgress += chunks.length;
		if (embeddingDimensions === undefined) {
			embeddingDimensions = chunks[0].vector.length;
		}
		if (opts.reset) {
			for (const c of chunks) {
				vocabSource.push({ name: c.name, content: c.content });
			}
		}
		emit?.({ phase: "store", current: storeProgress, total: newChunks.length });

		const completed: Array<{ filePath: string; fileHash: string }> = [];
		for (const c of chunks) {
			const left = (pendingByFile.get(c.filePath) ?? 0) - 1;
			pendingByFile.set(c.filePath, left);
			if (left === 0 && currentHashes.has(c.filePath)) {
				completed.push({
					filePath: c.filePath,
					fileHash: currentHashes.get(c.filePath)!,
				});
			}
		}
		if (completed.length > 0) await store.upsertFileHashes(completed);
	}

	let failedIndices: Set<number>;
	let aborted = false;

	try {
		const result = await resilient.embedBatched(texts, persistBatch);
		failedIndices = result.failedIndices;
	} catch (err) {
		if (err instanceof EmbeddingAbortError) {
			aborted = true;
			// Successes were already persisted incrementally via persistBatch.
			failedIndices = err.failedIndices;
			logger.error(err.message);
		} else {
			throw err;
		}
	}

	// Files whose every new chunk succeeded were already committed above. Commit
	// the rest that are nonetheless complete: files with no new chunks (only
	// already-indexed/oversized chunks) or that failed to chunk — as long as
	// none of their chunks failed to embed.
	const failedFiles = new Set<string>();
	for (const idx of failedIndices) failedFiles.add(newChunks[idx].filePath);

	const remainingHashEntries = changedPaths
		.filter(
			(fp) =>
				currentHashes.has(fp) &&
				!failedFiles.has(fp) &&
				(pendingByFile.get(fp) ?? 0) === 0,
		)
		.map((fp) => ({ filePath: fp, fileHash: currentHashes.get(fp)! }));
	if (remainingHashEntries.length > 0) {
		await store.upsertFileHashes(remainingHashEntries);
	}

	const failed = failedIndices.size;

	if (aborted) {
		if (succeeded > 0) {
			log(`Saved ${succeeded} chunks before aborting.`);
		}
		log(
			`Embedding failed. ${failed} chunks could not be embedded. ` +
				`Fix your embedding provider and run \`lmgrep index\` to resume.`,
		);
	} else {
		log(
			`Done: ${succeeded} chunks indexed from ${changedPaths.length} files` +
				(failed > 0 ? ` (${failed} failed)` : ""),
		);
	}

	// Build vocab table for faceting on full rebuilds. Incremental builds skip
	// this because df computed on a delta is meaningless — run `lmgrep facet
	// index` to (re)build the vocab from all existing chunks.
	if (opts.reset && vocabSource.length > 0) {
		await buildVocab(store, vocabSource, embedder, log);
	}

	// Update project metadata (preserve original model/dimensions as baseline)
	writeProjectMetadata(store.path, store.branch, cwd, {
		model: config.model,
		dimensions: embeddingDimensions,
	});

	// Sweep stale branch manifests for branches that no longer exist in git
	await sweepStaleBranches(cwd, store, logger);

	// Fold the rows just written into the ANN index and compact the fragments
	// they landed in. No-ops when the unindexed tail is still small, so the
	// watcher's 30s reconcile does not churn on every keystroke.
	//
	// `create` is deliberately off: first-time training reads every vector and
	// peaks at several GB, which must not happen behind a background watcher.
	// `opts.createIndex` lets a foreground command opt in. Never fatal — an
	// unoptimized index is slow and memory-hungry, not wrong.
	if (succeeded > 0) {
		try {
			const report = await store.optimize({
				create: opts.createIndex ?? false,
			});
			for (const t of report.tables) {
				if (t.action === "created") {
					log(`Built vector index on ${t.table} (${t.rows} rows)`);
				} else if (t.action === "optimized") {
					log(
						`Optimized ${t.table}: absorbed ${t.unindexed} unindexed rows`,
					);
				} else if (t.action === "needs-index") {
					log(
						`${t.table} has ${t.rows} rows and no vector index — ` +
							"searches scan every embedding. Run `lmgrep compact` to build one.",
					);
				}
			}
		} catch (err) {
			logger.error(
				`Index optimization skipped: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	return { succeeded, failed };
}

/**
 * Extract vocab terms from newly indexed chunks, embed those not already
 * present in the vocab table, and append the new entries. Keeps the vocab
 * table in sync with the chunk content incrementally.
 */
export async function buildVocab(
	store: Store,
	chunks: Iterable<{ name: string; content: string }>,
	embedder: Embedder,
	log: (msg: string) => void,
	opts: { minDf?: number; embedBatch?: number } = {},
): Promise<{ added: number }> {
	const minDf = opts.minDf ?? 10;
	const embedBatch = opts.embedBatch ?? 200;

	// Collect document-frequency across chunks
	const df = new Map<string, number>();
	for (const c of chunks) {
		const seen = new Set<string>();
		for (const t of tokenize(`${c.name} ${c.content}`)) {
			if (!seen.has(t)) {
				df.set(t, (df.get(t) ?? 0) + 1);
				seen.add(t);
			}
		}
	}
	if (df.size === 0) return { added: 0 };

	// Keep terms that appear in enough chunks to cut noise
	const candidates: string[] = [];
	for (const [term, count] of df) {
		if (count >= minDf) candidates.push(term);
	}
	if (candidates.length === 0) return { added: 0 };

	const known = await store.getVocabTerms();
	const toEmbed = candidates.filter((t) => !known.has(t));
	if (toEmbed.length === 0) return { added: 0 };

	log(`Embedding ${toEmbed.length} new vocab terms...`);
	let added = 0;
	for (let i = 0; i < toEmbed.length; i += embedBatch) {
		const batch = toEmbed.slice(i, i + embedBatch);
		const vectors = await embedder.embed(batch);
		const entries = batch.map((term, j) => ({ term, vector: vectors[j] }));
		await store.addVocab(entries);
		added += entries.length;
		log(`Vocab: ${added}/${toEmbed.length}`);
	}
	return { added };
}

async function sweepStaleBranches(
	cwd: string,
	store: Store,
	logger: Logger,
): Promise<void> {
	const gitBranchOutput = gitCmd(cwd, "branch", "--list", "--format=%(refname:short)");
	if (!gitBranchOutput) return;

	const gitBranches = new Set(gitBranchOutput.split("\n").filter(Boolean));
	// Always keep _default (non-git projects)
	gitBranches.add("_default");

	const storedBranches = await store.getStoredBranches();
	for (const branch of storedBranches) {
		if (!gitBranches.has(branch)) {
			await store.deleteBranchManifest(branch);
			logger.info(`Swept stale manifest for deleted branch "${branch}"`);
		}
	}
}
