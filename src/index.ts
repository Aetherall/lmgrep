import { loadConfig } from "./lib/config.js";
import { TreeSitterChunker } from "./lib/chunker/index.js";
import { AISDKEmbedder, type Embedder } from "./lib/embedder.js";
import { build, buildVocab } from "./lib/build.js";
import { repair } from "./lib/repair.js";
import { serve } from "./lib/serve.js";
import { resolve } from "node:path";
import {
	Store,
	findIndexedAncestor,
	resolveProject,
	resolveDb,
	readProjectMetadata,
	getDbPath,
	extractModelFamily,
	type ResolvedDb,
} from "./lib/store.js";
import type {
	BuildOptions,
	Chunker,
	FacetOptions,
	FacetResult,
	FacetSessionResult,
	FacetShowResult,
	Logger,
	LmgrepConfig,
	RepairResult,
	SearchOptions,
	SearchResult,
	StatusInfo,
} from "./lib/types.js";
import {
	bisecting,
	l2normalize,
	mean,
	stem,
	subtract,
	tokenize,
} from "./lib/vocab.js";
import {
	createSession,
	loadSession,
	nodeKey,
	parseFacetPath,
	saveSession,
	type FacetSession,
} from "./lib/facet-session.js";
import { consoleLogger } from "./lib/types.js";

export type {
	BuildOptions,
	Chunk,
	Chunker,
	FacetCluster,
	FacetOptions,
	FacetResult,
	FacetSessionResult,
	FacetShowResult,
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
	resolveDb,
	discoverIndexedProjects,
	writeProjectMetadata,
	readProjectMetadata,
	isDatabaseDir,
	extractModelFamily,
	acquireDbLock,
	releaseDbLock,
	isDbLocked,
	discoverRunningProcesses,
} from "./lib/store.js";
export type { ProjectMetadata, ResolvedDb, RunningProcess } from "./lib/store.js";
export { startWatcher } from "./lib/serve.js";
export { loadConfig, getConfigDir, getGlobalConfigPath } from "./lib/config.js";
export { startExport, startImport, generateShareCode, SHARE_CODE_RE } from "./lib/p2p.js";

export interface CreateIndexOptions {
	cwd: string;
	/**
	 * Target a specific database instead of the git-aware default. A bare name
	 * creates an independent index under `~/.local/state/lmgrep/<name>`; a path
	 * points at a specific database directory. See `resolveDb`.
	 */
	database?: string;
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
	facet(query: string, opts?: FacetOptions): Promise<FacetResult>;
	facetIndex(opts?: {
		minDf?: number;
		reset?: boolean;
	}): Promise<{ added: number; total: number }>;
	facetSearch(
		query: string,
		opts?: FacetOptions,
	): Promise<FacetSessionResult>;
	facetList(path: string): Promise<FacetSessionResult>;
	facetShow(path: string): Promise<FacetShowResult>;
	facetRefine(
		path: string,
		opts?: FacetOptions,
	): Promise<FacetSessionResult>;
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

	const resolved = resolveDb(cwd, options.database);
	const store = Store.forResolved(resolved);
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
			const meta = readProjectMetadata(resolved.dbPath);
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
			const targets = resolveSearchTargets(cwd, store, opts, resolved);
			const limit = opts.limit ?? 25;

			// Search all targets
			let results: SearchResult[] = [];
			for (const target of targets) {
				const targetResults = await target.store.search(
					queryVector,
					limit,
					target.filePrefix,
					opts.type,
					!target.projectRoot, // scope to branch for local project only
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

		async facet(query: string, opts: FacetOptions = {}) {
			const hits = await fetchFacetHits(query, opts);
			const clusters = await clusterAndLabel(hits, query, opts.k ?? 5);
			return { query, clusters };
		},

		async facetIndex(opts: { minDf?: number; reset?: boolean } = {}) {
			if (opts.reset) {
				await store.dropVocab();
			}
			const chunkCount = await store.chunkCount();
			if (chunkCount === 0) {
				logger.info(
					"No chunks indexed. Run `lmgrep index` first.",
				);
				return { added: 0, total: 0 };
			}
			logger.info(
				`Building vocab from ${chunkCount} chunks (minDf=${opts.minDf ?? 10})...`,
			);
			const buckets: Array<{ name: string; content: string }> = [];
			for await (const batch of store.streamChunkTexts()) {
				buckets.push(...batch);
			}
			const { added } = await buildVocab(
				store,
				buckets,
				embedder,
				(msg) => logger.info(msg),
				{ minDf: opts.minDf },
			);
			const total = await store.vocabCount();
			return { added, total };
		},

		async facetSearch(query: string, opts: FacetOptions = {}) {
			const hits = await fetchFacetHits(query, opts);
			const session = createSession(
				findProjectRoot(cwd),
				query,
				hits.map((h) => h.id),
			);
			const clusters = await clusterAndLabel(hits, query, opts.k ?? 5);
			writeChildren(session, [], hits, clusters);
			saveSession(findProjectRoot(cwd), session);
			return {
				sessionId: session.id,
				path: session.id,
				query,
				labels: clusters.map((c) => c.label),
				candidates: clusters.map((c) => c.candidates),
				qualifiers: clusters.map((c) => c.qualifiers ?? []),
				disambiguators: clusters.map((c) => c.disambiguators ?? []),
			};
		},

		async facetList(inputPath: string) {
			const parsed = parseFacetPath(inputPath);
			if (!parsed) throw new Error(`Invalid facet path: ${inputPath}`);
			const session = requireSession(cwd, parsed.id);
			const node = session.nodes[nodeKey(parsed.segments)];
			if (!node) {
				throw new Error(
					`Path not found in session: ${inputPath}. Run \`lmgrep facet refine\` first.`,
				);
			}
			if (!node.children) {
				throw new Error(
					`No facets computed at ${inputPath}. Run \`lmgrep facet refine ${inputPath}\`.`,
				);
			}
			return {
				sessionId: session.id,
				path: inputPath,
				query: session.query,
				labels: node.children.map((c) => c.label),
				candidates: node.children.map((c) => c.candidates ?? [c.label]),
				qualifiers: node.children.map((c) => c.qualifiers ?? []),
				disambiguators: node.children.map(
					(c) => c.disambiguators ?? [],
				),
			};
		},

		async facetShow(inputPath: string) {
			const parsed = parseFacetPath(inputPath);
			if (!parsed) throw new Error(`Invalid facet path: ${inputPath}`);
			const session = requireSession(cwd, parsed.id);
			const node = session.nodes[nodeKey(parsed.segments)];
			if (!node) {
				throw new Error(`Path not found in session: ${inputPath}`);
			}
			const chunks = await store.getChunksByIds(node.hits);
			// Preserve the node's order (retrieval rank).
			const byId = new Map(chunks.map((c) => [c.id, c]));
			const ordered = node.hits
				.map((id) => byId.get(id))
				.filter((c): c is NonNullable<typeof c> => !!c)
				.map(({ id: _id, vector: _v, ...rest }) => rest);
			return {
				sessionId: session.id,
				path: inputPath,
				query: session.query,
				results: ordered,
			};
		},

		async facetRefine(inputPath: string, opts: FacetOptions = {}) {
			const parsed = parseFacetPath(inputPath);
			if (!parsed) throw new Error(`Invalid facet path: ${inputPath}`);
			const session = requireSession(cwd, parsed.id);
			const node = session.nodes[nodeKey(parsed.segments)];
			if (!node) {
				throw new Error(`Path not found in session: ${inputPath}`);
			}
			const hits = await store.getChunksByIds(node.hits);
			if (hits.length === 0) {
				return {
					sessionId: session.id,
					path: inputPath,
					query: session.query,
					labels: [],
				};
			}
			const k = opts.k ?? 5;
			const clusters = await clusterAndLabel(
				hits,
				session.query,
				k,
				new Set(parsed.segments),
			);
			writeChildren(session, parsed.segments, hits, clusters);
			saveSession(findProjectRoot(cwd), session);
			return {
				sessionId: session.id,
				path: inputPath,
				query: session.query,
				labels: clusters.map((c) => c.label),
				candidates: clusters.map((c) => c.candidates),
				qualifiers: clusters.map((c) => c.qualifiers ?? []),
				disambiguators: clusters.map((c) => c.disambiguators ?? []),
			};
		},

		async repair(dry = false) {
			return repair(cwd, store, dry, logger);
		},

		async watch() {
			return serve(cwd, store, config, embedder, chunker, resolved, logger);
		},

		async status(): Promise<StatusInfo> {
			// A manually-targeted database is flat — no ancestor/prefix walking.
			const ancestor = resolved.manual ? undefined : findIndexedAncestor(cwd);
			const projectRoot = resolved.manual
				? resolved.root
				: ancestor
					? ancestor.root
					: cwd;
			const prefix = ancestor?.prefix ?? "";
			const statusStore =
				resolved.manual || projectRoot === cwd
					? store
					: Store.forProject(projectRoot);

			const files = await statusStore.getIndexedFiles();
			const hashes = await statusStore.getIndexedHashes();

			let totalChunks = 0;
			for (const [, h] of files) totalChunks += h.length;

			// Embed once with a generic query, then reuse the vector for the
			// smoke search — one network roundtrip covers both checks.
			let embeddingOk = false;
			let embeddingLatencyMs: number | undefined;
			let embeddingError: string | undefined;
			let searchOk = false;
			let searchResultCount: number | undefined;
			let searchLatencyMs: number | undefined;

			try {
				const embedStart = Date.now();
				const vector = await withTimeout(
					embedder.embedQuery("code"),
					3000,
				);
				embeddingLatencyMs = Date.now() - embedStart;
				embeddingOk = true;

				if (files.size > 0) {
					try {
						const searchStart = Date.now();
						const results = await withTimeout(
							statusStore.search(vector, 1),
							3000,
						);
						searchLatencyMs = Date.now() - searchStart;
						searchResultCount = results.length;
						searchOk = results.length > 0;
					} catch {}
				}
			} catch (err) {
				embeddingError = err instanceof Error ? err.message : String(err);
			}

			// Read index metadata for model/dimensions info
			const meta = readProjectMetadata(
				resolved.manual ? resolved.dbPath : getDbPath(projectRoot),
			);

			return {
				projectRoot,
				prefix,
				config,
				fileCount: files.size,
				chunkCount: totalChunks,
				uniqueHashes: hashes.size,
				embeddingOk,
				embeddingLatencyMs,
				embeddingError,
				searchOk,
				searchResultCount,
				searchLatencyMs,
				indexModel: meta?.model,
				indexDimensions: meta?.dimensions,
			};
		},

		async close() {
			await store.close();
		},
	};

	async function fetchFacetHits(query: string, opts: FacetOptions) {
		const limit = opts.limit ?? 25;
		const queryVector = await embedder.embedQuery(query);
		if (!(await store.hasVocab())) {
			throw new Error(
				"No vocab table found. Re-run `lmgrep index` to build it.",
			);
		}
		return store.searchWithVectors(queryVector, limit, opts.filePrefix);
	}

	async function clusterAndLabel(
		hits: Array<SearchResult & { id: string; vector: number[] }>,
		query: string,
		k: number,
		ancestorLabels: Set<string> = new Set(),
	): Promise<FacetResult["clusters"]> {
		if (hits.length === 0) return [];
		const normVecs = hits.map((h) => l2normalize(h.vector));
		const clusterIds = bisecting(normVecs, Math.min(k, hits.length));

		// Stem-based exclusion so query/ancestor tokens block their inflections too
		// (e.g. query "subscriptions" also excludes "subscription", "subscribe").
		const queryTokens = new Set(tokenize(query));
		const excludeStems = new Set<string>();
		for (const t of queryTokens) excludeStems.add(stem(t));
		for (const t of ancestorLabels) excludeStems.add(stem(t));
		const exclude = new Set<string>([...queryTokens, ...ancestorLabels]);

		const byCluster = new Map<number, number[]>();
		for (let i = 0; i < clusterIds.length; i++) {
			const c = clusterIds[i];
			const arr = byCluster.get(c) ?? [];
			arr.push(i);
			byCluster.set(c, arr);
		}

		// Precompute each cluster's unnormalized sum — lets us compute the
		// "mean of siblings" (Fisher-style between-class contrast) per cluster
		// without re-summing: sibMean = (totalSum - clusterSum) / (N - |c|).
		// This is stronger than `cluster - globalCentroid` because the global
		// mean includes the cluster's own mass (dilutes the axis) and is biased
		// toward large clusters.
		const dim = normVecs[0].length;
		const clusterSums = new Map<number, number[]>();
		for (const [c, idxs] of byCluster) {
			const s = new Array(dim).fill(0);
			for (const i of idxs) {
				const v = normVecs[i];
				for (let d = 0; d < dim; d++) s[d] += v[d];
			}
			clusterSums.set(c, s);
		}
		const totalSum = new Array(dim).fill(0);
		for (const s of clusterSums.values()) {
			for (let d = 0; d < dim; d++) totalSum[d] += s[d];
		}
		const N = normVecs.length;

		// Stable cluster ordering so pairwise bookkeeping is predictable.
		const clusterIdsInOrder = [...byCluster.keys()];
		const clusterCentroids = new Map<number, number[]>();
		for (const cid of clusterIdsInOrder) {
			const idxs = byCluster.get(cid)!;
			const memVecs = idxs.map((i) => normVecs[i]);
			clusterCentroids.set(cid, l2normalize(mean(memVecs)));
		}

		// Pass 1: pick the primary label + candidates per cluster using the
		// sibling-mean axis (c_i - mean(others)). Dedup by stem (so labels
		// don't collide via surface inflection).
		const usedStems = new Set<string>(excludeStems);
		const primary = new Map<
			number,
			{ label: string; labelStem: string; candidates: string[] }
		>();
		for (const cid of clusterIdsInOrder) {
			const idxs = byCluster.get(cid)!;
			const clusterC = clusterCentroids.get(cid)!;
			const cSum = clusterSums.get(cid)!;
			const sibCount = N - idxs.length;
			let axis: number[];
			if (sibCount <= 0) {
				axis = clusterC;
			} else {
				const sibMean = new Array(dim);
				for (let d = 0; d < dim; d++) {
					sibMean[d] = (totalSum[d] - cSum[d]) / sibCount;
				}
				axis = l2normalize(subtract(clusterC, l2normalize(sibMean)));
			}
			const cands = await store.searchVocab(axis, 10, exclude);
			let label = "other";
			let labelStem = "";
			for (const c of cands) {
				const s = stem(c.term);
				if (!usedStems.has(s)) {
					label = c.term;
					labelStem = s;
					usedStems.add(s);
					break;
				}
			}
			// Top-4 terms for the overview (label first), deduped by stem so
			// e.g. "subscription, subscriptions" don't both appear.
			const top: string[] = [];
			const topStems = new Set<string>();
			if (label !== "other") {
				top.push(label);
				topStems.add(labelStem);
			}
			for (const c of cands) {
				if (top.length >= 4) break;
				const s = stem(c.term);
				if (topStems.has(s)) continue;
				top.push(c.term);
				topStems.add(s);
			}
			primary.set(cid, { label, labelStem, candidates: top });
		}

		// Pass 2: pairwise disambiguators. For each cluster i, run a vocab ANN
		// on (c_i - c_j) for every sibling j and take top-3 terms. Reveals the
		// specific boundary between i and each neighbor — richer than the
		// collapsed sibling-mean axis for verbose views.
		//
		// Also derives a compact "qualifiers" list per cluster for the default
		// display: one top term per sibling, dedup'd against the primary label
		// and across siblings, filtered by a confidence floor so weak boundaries
		// don't add noise.
		const QUALIFIER_MAX = 4;
		const disambigByCluster = new Map<
			number,
			Array<{ vs: string; terms: string[] }>
		>();
		const qualifiersByCluster = new Map<number, string[]>();
		for (const cid of clusterIdsInOrder) {
			const rows: Array<{ vs: string; terms: string[] }> = [];
			const ci = clusterCentroids.get(cid)!;
			const selfLabel = primary.get(cid)!.label;
			const selfStem = primary.get(cid)!.labelStem;
			const qualifiers: string[] = [];
			// Stem-based dedup so "subscribe"/"subscribed" don't both appear.
			const qualifierStems = new Set<string>([selfStem]);
			for (const oid of clusterIdsInOrder) {
				if (oid === cid) continue;
				const cj = clusterCentroids.get(oid)!;
				const axis = l2normalize(subtract(ci, cj));
				const otherLabel = primary.get(oid)!.label;
				const pairExclude = new Set([
					...exclude,
					selfLabel,
					otherLabel,
				]);
				const cands = await store.searchVocab(axis, 8, pairExclude);
				// Intra-row dedup by stem too.
				const termStems = new Set<string>([
					selfStem,
					primary.get(oid)!.labelStem,
				]);
				const terms: string[] = [];
				for (const c of cands) {
					if (terms.length >= 3) break;
					const s = stem(c.term);
					if (termStems.has(s)) continue;
					terms.push(c.term);
					termStems.add(s);
				}
				rows.push({ vs: otherLabel, terms });

				if (qualifiers.length >= QUALIFIER_MAX) continue;
				for (const c of cands) {
					const s = stem(c.term);
					if (qualifierStems.has(s)) continue;
					qualifiers.push(c.term);
					qualifierStems.add(s);
					break;
				}
			}
			disambigByCluster.set(cid, rows);
			qualifiersByCluster.set(cid, qualifiers);
		}

		const clusters: FacetResult["clusters"] = [];
		for (const cid of clusterIdsInOrder) {
			const idxs = byCluster.get(cid)!;
			const { label, candidates } = primary.get(cid)!;
			clusters.push({
				label,
				candidates,
				qualifiers: qualifiersByCluster.get(cid),
				disambiguators: disambigByCluster.get(cid),
				size: idxs.length,
				results: idxs.map((i) => {
					const { id: _id, vector: _v, ...rest } = hits[i];
					return rest;
				}),
				_memberIndices: idxs,
			} as FacetResult["clusters"][number] & { _memberIndices: number[] });
		}

		clusters.sort((a, b) => b.size - a.size);
		return clusters;
	}
}

function findProjectRoot(cwd: string): string {
	const ancestor = findIndexedAncestor(cwd);
	return ancestor ? ancestor.root : cwd;
}

function requireSession(cwd: string, id: string): FacetSession {
	const session = loadSession(findProjectRoot(cwd), id);
	if (!session) {
		throw new Error(
			`Unknown facet session: ${id}. Run \`lmgrep facet search <query>\` first.`,
		);
	}
	return session;
}

/**
 * Attach computed clusters as children of the node at `segments`, and create
 * nodes for each child so they can be listed/shown/refined later.
 */
function writeChildren(
	session: FacetSession,
	segments: string[],
	hits: Array<{ id: string }>,
	clusters: Array<
		{
			label: string;
			size: number;
			candidates?: string[];
			qualifiers?: string[];
			disambiguators?: Array<{ vs: string; terms: string[] }>;
		} & { _memberIndices?: number[] }
	>,
): void {
	const parentKey = nodeKey(segments);
	const parent = session.nodes[parentKey];
	if (!parent) return;

	const children: NonNullable<FacetSession["nodes"][string]["children"]> = [];
	for (const c of clusters) {
		const memberIdxs = c._memberIndices ?? [];
		const childHits = memberIdxs.map((i) => hits[i].id);
		children.push({
			label: c.label,
			size: c.size,
			hits: childHits,
			candidates: c.candidates,
			qualifiers: c.qualifiers,
			disambiguators: c.disambiguators,
		});

		const childKey = nodeKey([...segments, c.label]);
		if (!session.nodes[childKey]) {
			session.nodes[childKey] = {
				path: childKey,
				hits: childHits,
			};
		}
	}
	parent.children = children;
}

// --- Internal helpers ---

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

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
	resolved: ResolvedDb,
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

	// Default: search local project, resolving ancestor prefix. A
	// manually-targeted database is flat — search it as-is with no prefix.
	let filePrefix = opts.filePrefix;
	let searchStore = localStore;
	if (!resolved.manual) {
		const ancestor = findIndexedAncestor(cwd);
		if (ancestor?.prefix) {
			searchStore = Store.forProject(ancestor.root);
			filePrefix = filePrefix
				? `${ancestor.prefix}/${filePrefix}`
				: ancestor.prefix;
		}
	}

	return [{ store: searchStore, filePrefix }];
}
