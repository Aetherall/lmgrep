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
	return withWriteLock(cwd, () =>
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

	let vectors: (number[] | null)[];
	let failedIndices: Set<number>;
	let aborted = false;

	try {
		const result = await resilient.embedBatched(texts);
		vectors = result.vectors;
		failedIndices = result.failedIndices;
	} catch (err) {
		if (err instanceof EmbeddingAbortError) {
			aborted = true;
			vectors = err.vectors;
			failedIndices = err.failedIndices;
			logger.error(err.message);
		} else {
			throw err;
		}
	}

	// Store successful chunks
	const indexed: IndexedChunk[] = [];
	const failedFiles = new Set<string>();
	let embeddingDimensions: number | undefined;

	for (let i = 0; i < newChunks.length; i++) {
		if (vectors[i] !== null) {
			indexed.push({ ...newChunks[i], vector: vectors[i]! });
			if (embeddingDimensions === undefined) {
				embeddingDimensions = vectors[i]!.length;
			}
		} else {
			failedFiles.add(newChunks[i].filePath);
		}
	}

	if (indexed.length > 0) {
		const STORE_BATCH = 500;
		for (let i = 0; i < indexed.length; i += STORE_BATCH) {
			await store.addChunks(indexed.slice(i, i + STORE_BATCH));
			emit?.({
				phase: "store",
				current: Math.min(i + STORE_BATCH, indexed.length),
				total: indexed.length,
			});
		}
	}

	// Save file hashes for files with no failures
	const hashEntries = changedPaths
		.filter((fp) => currentHashes.has(fp) && !failedFiles.has(fp))
		.map((fp) => ({ filePath: fp, fileHash: currentHashes.get(fp)! }));
	if (hashEntries.length > 0) await store.upsertFileHashes(hashEntries);

	const succeeded = indexed.length;
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
	if (opts.reset && indexed.length > 0) {
		await buildVocab(
			store,
			indexed.map((c) => ({ name: c.name, content: c.content })),
			embedder,
			log,
		);
	}

	// Update project metadata (preserve original model/dimensions as baseline)
	writeProjectMetadata(cwd, {
		model: config.model,
		dimensions: embeddingDimensions,
	});

	// Sweep stale branch manifests for branches that no longer exist in git
	await sweepStaleBranches(cwd, store, logger);

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
