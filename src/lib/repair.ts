import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkFiles } from "./scanner.js";
import type { Store } from "./store.js";
import type { Chunker, Logger, RepairResult } from "./types.js";
import { consoleLogger } from "./types.js";

export async function repair(
	cwd: string,
	store: Store,
	chunker: Chunker,
	dry = false,
	logger: Logger = consoleLogger,
): Promise<RepairResult> {
	const log = logger.info.bind(logger);
	log("Scanning index for inconsistencies...");

	const chunkCountBefore = await store.chunkCount();
	const indexedFiles = await store.getIndexedFiles();
	const storedFileHashes = await store.getFileHashes();
	const diskFiles = new Set(walkFiles(cwd));

	// 1. Orphaned files (indexed but deleted from disk)
	const orphaned: string[] = [];
	const allIndexedPaths = new Set([
		...indexedFiles.keys(),
		...storedFileHashes.keys(),
	]);
	for (const fp of allIndexedPaths) {
		if (!diskFiles.has(fp)) orphaned.push(fp);
	}

	// 2. Stale files (hash mismatch)
	const stale: string[] = [];
	for (const fp of diskFiles) {
		const storedHash = storedFileHashes.get(fp);
		if (!storedHash) continue;
		try {
			const content = readFileSync(join(cwd, fp));
			const currentHash = createHash("sha256")
				.update(content)
				.digest("hex")
				.slice(0, 16);
			if (storedHash !== currentHash) stale.push(fp);
		} catch {
			orphaned.push(fp);
		}
	}

	// 3. Chunk mismatches
	const chunkMismatch: string[] = [];
	for (const [fp, indexedHashes] of indexedFiles) {
		if (orphaned.includes(fp) || stale.includes(fp)) continue;
		if (!diskFiles.has(fp)) continue;

		try {
			const currentChunks = await chunker.chunk(fp, cwd);
			const currentHashSet = new Set(currentChunks.map((c) => c.hash));
			const indexedSet = new Set(indexedHashes);

			const hasStale = indexedHashes.some(
				(h) => !currentHashSet.has(h),
			);
			const hasMissing = currentChunks.some(
				(c) => !indexedSet.has(c.hash),
			);

			if (hasStale || hasMissing) chunkMismatch.push(fp);
		} catch {
			// skip
		}
	}

	const total = orphaned.length + stale.length + chunkMismatch.length;

	if (total === 0) {
		log("Index is consistent. No repairs needed.");
		return {
			orphaned: [],
			stale: [],
			chunkMismatch: [],
			chunksRemoved: 0,
		};
	}

	log(`Found ${total} issues:`);
	if (orphaned.length > 0) log(`  ${orphaned.length} orphaned files`);
	if (stale.length > 0) log(`  ${stale.length} stale files`);
	if (chunkMismatch.length > 0)
		log(`  ${chunkMismatch.length} chunk mismatches`);

	if (dry) {
		for (const fp of orphaned) log(`  [orphan]   ${fp}`);
		for (const fp of stale) log(`  [stale]    ${fp}`);
		for (const fp of chunkMismatch) log(`  [mismatch] ${fp}`);
		return { orphaned, stale, chunkMismatch, chunksRemoved: 0 };
	}

	if (orphaned.length > 0) {
		await store.deleteChunksByFiles(orphaned);
		await store.deleteFileHashes(orphaned);
		log(`Removed ${orphaned.length} orphaned files`);
	}

	const toInvalidate = [...stale, ...chunkMismatch];
	if (toInvalidate.length > 0) {
		await store.deleteChunksByFiles(toInvalidate);
		await store.deleteFileHashes(toInvalidate);
		log(
			`Invalidated ${toInvalidate.length} files — run \`lmgrep index\` to re-embed`,
		);
	}

	const chunkCountAfter = await store.chunkCount();
	const chunksRemoved = chunkCountBefore - chunkCountAfter;
	log(`Repair complete. Removed ${chunksRemoved} stale chunks.`);

	return { orphaned, stale, chunkMismatch, chunksRemoved };
}
