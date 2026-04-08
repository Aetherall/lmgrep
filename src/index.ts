import { loadConfig } from "./lib/config.js";
import { TreeSitterChunker } from "./lib/chunker/index.js";
import { AISDKEmbedder, type Embedder } from "./lib/embedder.js";
import { build } from "./lib/build.js";
import { repair } from "./lib/repair.js";
import { serve } from "./lib/serve.js";
import { resolve } from "node:path";
import {
	Store,
	findIndexedAncestor,
	resolveProject,
	readProjectMetadata,
	getDbPath,
	extractModelFamily,
} from "./lib/store.js";
import type {
	BuildOptions,
	Chunker,
	Logger,
	LmgrepConfig,
	RepairResult,
	SearchOptions,
	SearchResult,
	StatusInfo,
} from "./lib/types.js";
import { consoleLogger } from "./lib/types.js";

export type {
	BuildOptions,
	Chunk,
	Chunker,
	FileChange,
	FileEntry,
	IndexedChunk,
	Logger,
	LmgrepConfig,
	ProgressEvent,
	RepairResult,
	SearchOptions,
	SearchResult,
	StatusInfo,
} from "./lib/types.js";

export { consoleLogger, silentLogger } from "./lib/types.js";
export type { Embedder } from "./lib/embedder.js";

export { AISDKEmbedder, EmbeddingAbortError } from "./lib/embedder.js";
export { TreeSitterChunker } from "./lib/chunker/index.js";
export {
	Store,
	findIndexedAncestor,
	getDbPath,
	getLegacyDbPath,
	resolveProject,
	discoverIndexedProjects,
	writeProjectMetadata,
	readProjectMetadata,
	extractModelFamily,
	acquireDbLock,
	releaseDbLock,
	isDbLocked,
} from "./lib/store.js";
export type { ProjectMetadata } from "./lib/store.js";
export { startWatcher } from "./lib/serve.js";
export { loadConfig, getConfigDir, getGlobalConfigPath } from "./lib/config.js";

export interface CreateIndexOptions {
	cwd: string;
	config?: Partial<LmgrepConfig>;
	embedder?: Embedder;
	chunker?: Chunker;
	logger?: Logger;
}

export interface LmgrepIndex {
	readonly cwd: string;
	readonly config: LmgrepConfig;

	build(opts?: BuildOptions): Promise<{ succeeded: number; failed: number }>;
	search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
	repair(dry?: boolean): Promise<RepairResult>;
	watch(): Promise<void>;
	status(): Promise<StatusInfo>;
	close(): Promise<void>;
}

export async function createIndex(
	options: CreateIndexOptions,
): Promise<LmgrepIndex> {
	const { cwd } = options;

	// Resolve config: user overrides > file config > defaults
	const fileConfig = loadConfig(cwd);
	const config: LmgrepConfig = { ...fileConfig, ...options.config };

	const store = Store.forProject(cwd);
	const embedder = options.embedder ?? new AISDKEmbedder(config);
	const chunker = options.chunker ?? new TreeSitterChunker();
	const logger = options.logger ?? consoleLogger;

	return {
		cwd,
		config,

		async build(opts?: BuildOptions) {
			return build(cwd, store, config, embedder, chunker, opts, logger);
		},

		async search(query: string, opts: SearchOptions = {}) {
			let queryVector = await embedder.embedQuery(query);

			// Check model compatibility with the index
			const dbPath = getDbPath(cwd);
			const meta = readProjectMetadata(dbPath);
			if (meta) {
				// Hard error: dimension mismatch
				if (meta.dimensions != null && queryVector.length !== meta.dimensions) {
					throw new Error(
						`Dimension mismatch: index has ${meta.dimensions}-dim vectors but your model produces ${queryVector.length}-dim. ` +
						`These embeddings are incompatible.`,
					);
				}

				// Advisory: model family mismatch
				if (meta.model) {
					const indexFamily = extractModelFamily(meta.model);
					const queryFamily = extractModelFamily(config.model);
					if (indexFamily !== queryFamily) {
						logger.info(
							`Warning: index was built with "${meta.model}" (${indexFamily}) ` +
							`but searching with "${config.model}" (${queryFamily}). ` +
							`Results may be degraded if these are different model families.`,
						);
					}
				}
			}

			// Subtract the --not vector to push away unwanted results
			if (opts.not) {
				const notVector = await embedder.embedQuery(opts.not);
				queryVector = queryVector.map(
					(v, i) => v - notVector[i] * 0.5,
				);
			}

			// Determine which stores to search
			const targets = resolveSearchTargets(cwd, store, opts);
			const limit = opts.limit ?? 25;

			// Search all targets
			let results: SearchResult[] = [];
			for (const target of targets) {
				const targetResults = await target.store.search(
					queryVector,
					limit,
					target.filePrefix,
					opts.type,
				);

				// Tag results from foreign projects with their root
				if (target.projectRoot) {
					for (const r of targetResults) {
						r.filePath = `${target.projectRoot}/${r.filePath}`;
					}
				}

				results.push(...targetResults);
			}

			// When searching multiple targets, sort by score and trim
			if (targets.length > 1) {
				results.sort((a, b) => b.score - a.score);
				results = results.slice(0, limit);
			}

			// Post-filter by language (file extension)
			if (opts.language && opts.language.length > 0) {
				const exts = new Set(
					opts.language.map((l) => (l.startsWith(".") ? l : `.${l}`)),
				);
				results = results.filter((r) =>
					exts.has(r.filePath.slice(r.filePath.lastIndexOf("."))),
				);
			}

			if (opts.minScore != null) {
				results = results.filter((r) => r.score >= opts.minScore!);
			}

			// Close any foreign stores we opened
			for (const target of targets) {
				if (target.store !== store) {
					await target.store.close();
				}
			}

			return results;
		},

		async repair(dry = false) {
			return repair(cwd, store, chunker, dry, logger);
		},

		async watch() {
			return serve(cwd, store, config, embedder, chunker, logger);
		},

		async status(): Promise<StatusInfo> {
			const ancestor = findIndexedAncestor(cwd);
			const projectRoot = ancestor ? ancestor.root : cwd;
			const prefix = ancestor?.prefix ?? "";
			const statusStore =
				projectRoot === cwd ? store : Store.forProject(projectRoot);

			const files = await statusStore.getIndexedFiles();
			const hashes = await statusStore.getIndexedHashes();

			let totalChunks = 0;
			for (const [, h] of files) totalChunks += h.length;

			let embeddingOk = false;
			let embeddingLatencyMs: number | undefined;
			try {
				const start = Date.now();
				await embedder.embedQuery("test");
				embeddingLatencyMs = Date.now() - start;
				embeddingOk = true;
			} catch {}

			// Read index metadata for model/dimensions info
			const meta = readProjectMetadata(getDbPath(projectRoot));

			return {
				projectRoot,
				prefix,
				config,
				fileCount: files.size,
				chunkCount: totalChunks,
				uniqueHashes: hashes.size,
				embeddingOk,
				embeddingLatencyMs,
				indexModel: meta?.model,
				indexDimensions: meta?.dimensions,
			};
		},

		async close() {
			await store.close();
		},
	};
}

// --- Internal helpers ---

interface SearchTarget {
	store: Store;
	filePrefix?: string;
	/** Absolute path prefix for results from foreign projects (undefined for local) */
	projectRoot?: string;
}

function resolveSearchTargets(
	cwd: string,
	localStore: Store,
	opts: SearchOptions,
): SearchTarget[] {
	// --across: search multiple projects
	if (opts.across && opts.across.length > 0) {
		const targets: SearchTarget[] = [
			{ store: localStore, filePrefix: opts.filePrefix },
		];
		for (const p of opts.across) {
			const abs = resolve(cwd, p);
			const { root } = resolveProject(abs);
			targets.push({
				store: Store.forProject(abs),
				filePrefix: opts.filePrefix,
				projectRoot: root,
			});
		}
		return targets;
	}

	// --project: search a single foreign project
	if (opts.project) {
		const abs = resolve(cwd, opts.project);
		const { root } = resolveProject(abs);
		return [
			{
				store: Store.forProject(abs),
				filePrefix: opts.filePrefix,
				projectRoot: root,
			},
		];
	}

	// Default: search local project, resolving ancestor prefix
	let filePrefix = opts.filePrefix;
	let searchStore = localStore;
	const ancestor = findIndexedAncestor(cwd);
	if (ancestor?.prefix) {
		searchStore = Store.forProject(ancestor.root);
		filePrefix = filePrefix
			? `${ancestor.prefix}/${filePrefix}`
			: ancestor.prefix;
	}

	return [{ store: searchStore, filePrefix }];
}
