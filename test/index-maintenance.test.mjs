import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Index } from "@lancedb/lancedb";
import { ContentHash } from "../dist/domain/corpus/ContentHash.js";
import { Branch } from "../dist/domain/project/Branch.js";
import { FileManifestRepository } from "../dist/infrastructure/lancedb/FileManifestRepository.js";
import { IndexMaintenance } from "../dist/infrastructure/lancedb/IndexMaintenance.js";
import {
	LanceTables,
	TableName,
} from "../dist/infrastructure/lancedb/LanceTables.js";

test("cleanup deletes only duplicate and stale row ids, preserving table, index and vectors", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "lmgrep-cleanup-"));
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
	const other = new FileManifestRepository(tables, Branch.of("feature"));
	await other.upsert([
		{ path: "source.ts", hash: ContentHash.fromStored("feature") },
	]);
	const record = (id, fileHash, marker) => ({
		id,
		filePath: "source.ts",
		fileHash,
		marker,
		vector: [1, 2, 3],
	});
	const rows = [
		record("reused", "stale", "remove"),
		record("reused", "current", "keep"),
		record("other", "feature", "keep"),
		record("legacy", "", "keep"),
	];
	for (let i = 0; i < 4100; i++)
		rows.push(record("duplicate", "current", i === 0 ? "keep" : "remove"));
	const { table } = await tables.tableOrCreate(TableName.Chunks, rows);
	await table.createIndex("id", { config: Index.btree() });
	const version = await table.version();
	const maintenance = new IndexMaintenance(tables, manifest);
	assert.deepEqual(await maintenance.dedupe(), {
		before: 4104,
		after: 4,
		duplicateIds: 4099,
		staleVersions: 1,
	});
	assert.ok((await table.version()) > version);
	assert.ok(
		(await table.listIndices()).some((index) => index.columns.includes("id")),
	);
	const remaining = await table.query().toArray();
	assert.equal(remaining.length, 4);
	assert.ok(remaining.every((row) => row.marker === "keep"));
	assert.ok(
		remaining.every(
			(row) => JSON.stringify(Array.from(row.vector)) === "[1,2,3]",
		),
	);
	assert.deepEqual(await maintenance.dedupe(), {
		before: 4,
		after: 4,
		duplicateIds: 0,
		staleVersions: 0,
	});
});
