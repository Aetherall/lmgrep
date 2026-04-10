import { existsSync } from "node:fs";
import { build } from "./build.js";
import type { Embedder } from "./embedder.js";
import { watchFiles } from "./scanner.js";
import {
	type Store,
	getDbPath,
	findIndexedAncestor,
	acquireDbLock,
	releaseDbLock,
	isDbLocked,
} from "./store.js";
import type { Chunker, Logger, LmgrepConfig } from "./types.js";
import { consoleLogger } from "./types.js";

export { isDbLocked as isServeLocked };

// --- Serve ---

export async function serve(
	cwd: string,
	store: Store,
	config: LmgrepConfig,
	embedder: Embedder,
	chunker: Chunker,
	logger: Logger = consoleLogger,
): Promise<void> {
	const log = logger.info.bind(logger);

	// Require an existing index
	const ancestor = findIndexedAncestor(cwd);
	if (!ancestor) {
		const dbPath = getDbPath(cwd);
		if (!existsSync(dbPath)) {
			throw new Error("No index found. Run `lmgrep index` first.");
		}
	}

	if (!acquireDbLock(cwd)) {
		throw new Error("Already running for this project.");
	}

	const cleanup = () => releaseDbLock(cwd);
	process.on("exit", cleanup);
	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});

	// Initial index
	log("Running initial index...");
	await build(cwd, store, config, embedder, chunker, {}, logger);

	// Watch with non-recursive re-trigger and per-file targeting
	let indexing = false;
	let pendingFiles: string[] | undefined;

	async function runIndex(changedFiles?: string[]): Promise<void> {
		if (indexing) {
			// Merge into pending set
			if (changedFiles) {
				pendingFiles = [...(pendingFiles ?? []), ...changedFiles];
			} else {
				pendingFiles = undefined; // full rebuild queued
			}
			return;
		}
		indexing = true;
		try {
			const fileCount = changedFiles?.length;
			log(
				fileCount
					? `Changes detected in ${fileCount} file(s), re-indexing...`
					: "Changes detected, re-indexing...",
			);
			await build(
				cwd,
				store,
				config,
				embedder,
				chunker,
				{ files: changedFiles },
				logger,
			);
		} catch (err) {
			logger.error(
				`Index error: ${err instanceof Error ? err.message : err}`,
			);
		} finally {
			indexing = false;
			if (pendingFiles !== undefined) {
				const next = pendingFiles.length > 0 ? pendingFiles : undefined;
				pendingFiles = undefined;
				runIndex(next);
			}
		}
	}

	watchFiles(cwd, config.ignore, (changedFiles) => {
		runIndex(changedFiles);
	}, 2000, config.extensions);

	log("Watching for changes...");
}

/**
 * Start an in-process file watcher that incrementally re-indexes on changes.
 * Acquires the DB lock. Returns a cleanup function to stop watching and release the lock.
 * Returns undefined if the lock is already held by another process.
 */
export function startWatcher(
	cwd: string,
	store: Store,
	config: LmgrepConfig,
	embedder: Embedder,
	chunker: Chunker,
	logger: Logger = consoleLogger,
): (() => void) | undefined {
	if (!acquireDbLock(cwd)) {
		return undefined;
	}

	const log = logger.info.bind(logger);
	let indexing = false;
	let pendingFiles: string[] | undefined;

	async function runIndex(changedFiles?: string[]): Promise<void> {
		if (indexing) {
			if (changedFiles) {
				pendingFiles = [...(pendingFiles ?? []), ...changedFiles];
			} else {
				pendingFiles = undefined;
			}
			return;
		}
		indexing = true;
		try {
			const fileCount = changedFiles?.length;
			log(
				fileCount
					? `Changes detected in ${fileCount} file(s), re-indexing...`
					: "Changes detected, re-indexing...",
			);
			await build(
				cwd,
				store,
				config,
				embedder,
				chunker,
				{ files: changedFiles },
				logger,
			);
		} catch (err) {
			logger.error(
				`Index error: ${err instanceof Error ? err.message : err}`,
			);
		} finally {
			indexing = false;
			if (pendingFiles !== undefined) {
				const next = pendingFiles.length > 0 ? pendingFiles : undefined;
				pendingFiles = undefined;
				runIndex(next);
			}
		}
	}

	// Kick off an initial catch-up index so newly-checked-out branches get
	// their manifest bootstrapped and any changes made while offline are picked up.
	runIndex();

	const watcher = watchFiles(
		cwd,
		config.ignore,
		(changedFiles) => {
			runIndex(changedFiles);
		},
		2000,
		config.extensions,
	);

	log("Watching for changes...");

	return () => {
		watcher.close();
		releaseDbLock(cwd);
	};
}
