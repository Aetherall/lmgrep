import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContentHash } from "../dist/domain/corpus/ContentHash.js";
import { Vector } from "../dist/domain/corpus/Vector.js";
import { Branch } from "../dist/domain/project/Branch.js";
import { ChunkRepository } from "../dist/infrastructure/lancedb/ChunkRepository.js";
import { FileManifestRepository } from "../dist/infrastructure/lancedb/FileManifestRepository.js";
import {
	LanceTables,
	TableName,
} from "../dist/infrastructure/lancedb/LanceTables.js";

const row = (id, fileHash, distance, filePath = "source.ts") => ({
	id,
	filePath,
	fileHash,
	startLine: distance * 10 + 1,
	endLine: distance * 10 + 2,
	type: "function_declaration",
	name: id,
	content: id,
	context: "",
	hash: id,
	vector: [distance, 0, 0],
});

async function repository(t, rows) {
	const root = mkdtempSync(join(tmpdir(), "lmgrep-search-limit-"));
	const branch = Branch.of("main");
	const tables = new LanceTables(root, branch);
	t.after(() => {
		tables.close();
		rmSync(root, { recursive: true, force: true });
	});
	const manifest = new FileManifestRepository(tables, branch);
	await manifest.upsert([
		{ path: "source.ts", hash: ContentHash.fromStored("current") },
	]);
	await tables.tableOrCreate(TableName.Chunks, rows);
	return new ChunkRepository(tables, manifest, branch);
}

const query = (limit, options = {}) => ({
	vector: Vector.zeros(3),
	limit,
	scopeToBranch: true,
	...options,
});

const staleRows = () =>
	Array.from({ length: 30 }, (_, i) => row(`stale-${i}`, "other-branch", i));

test("small limits reach current-branch hits beyond other branches' nearest candidates", async (t) => {
	const chunks = await repository(t, [
		...staleRows(),
		row("current-1", "current", 31),
		row("current-2", "current", 32),
		row("current-3", "current", 33),
	]);
	for (const limit of [1, 2, 3, 25]) {
		const hits = await chunks.search(query(limit));
		assert.deepEqual(
			hits.toArray().map((hit) => hit.id),
			["current-1", "current-2", "current-3"].slice(0, limit),
		);
	}
});

test("exhaustion returns a partial page or no hits without leaking other branches", async (t) => {
	const chunks = await repository(t, [
		...staleRows(),
		row("current-1", "current", 31),
	]);
	assert.equal((await chunks.search(query(2))).length, 1);
	assert.equal(
		(await chunks.search(query(2, { filePrefix: "missing/" }))).length,
		0,
	);
});

test("deduplication also expands retrieval for unscoped searches", async (t) => {
	const chunks = await repository(t, [
		...Array.from({ length: 20 }, () => row("duplicate", "current", 0)),
		row("distinct", "current", 1),
	]);
	assert.deepEqual(
		(await chunks.search(query(2, { scopeToBranch: false })))
			.toArray()
			.map((hit) => hit.id),
		["duplicate", "distinct"],
	);
});

test("an exhausted branch with no matching versions returns an empty page", async (t) => {
	const chunks = await repository(t, staleRows());
	assert.equal((await chunks.search(query(2))).length, 0);
});
