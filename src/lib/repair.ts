import { hashFile, walkFiles } from "./scanner.js";
import type { Store } from "./store.js";
import type { Logger, RepairResult } from "./types.js";
import { consoleLogger } from "./types.js";

/**
 * Reconcile the current-branch file manifest with the working tree.
 * Any manifest row whose path is missing from disk, or whose stored hash
 * disagrees with the on-disk hash, is removed. Chunks for those paths are
 * deleted too (guarded cross-branch inside the store). The next
 * `lmgrep index` run will then treat those files as additions and re-embed.
 */
export async function repair(
	cwd: string,
	store: Store,
	dry = false,
	logger: Logger = consoleLogger,
): Promise<RepairResult> {
	const log = logger.info.bind(logger);
	log("Reconciling current-branch manifest with working tree...");

	const chunkCountBefore = await store.chunkCount();
	const storedFileHashes = await store.getFileHashes();
	const diskFiles = new Set(walkFiles(cwd));

	const orphaned: string[] = [];
	const stale: string[] = [];

	for (const [fp, storedHash] of storedFileHashes) {
		if (!diskFiles.has(fp)) {
			orphaned.push(fp);
			continue;
		}
		const currentHash = hashFile(cwd, fp);
		if (currentHash === undefined) {
			orphaned.push(fp);
			continue;
		}
		if (currentHash !== storedHash) stale.push(fp);
	}

	const total = orphaned.length + stale.length;

	if (total === 0) {
		log("Manifest matches working tree. No repairs needed.");
		return { orphaned: [], stale: [], chunksRemoved: 0 };
	}

	log(`Found ${total} inconsistencies:`);
	if (orphaned.length > 0) log(`  ${orphaned.length} orphaned files`);
	if (stale.length > 0) log(`  ${stale.length} stale files`);

	if (dry) {
		for (const fp of orphaned) log(`  [orphan] ${fp}`);
		for (const fp of stale) log(`  [stale]  ${fp}`);
		return { orphaned, stale, chunksRemoved: 0 };
	}

	const toDrop = [...orphaned, ...stale];
	await store.deleteChunksByFiles(toDrop);
	await store.deleteFileHashes(toDrop);

	const chunkCountAfter = await store.chunkCount();
	const chunksRemoved = chunkCountBefore - chunkCountAfter;

	log(
		`Dropped ${toDrop.length} manifest entries (${chunksRemoved} chunks removed). ` +
			`Run \`lmgrep index\` to re-embed stale files.`,
	);

	return { orphaned, stale, chunksRemoved };
}
