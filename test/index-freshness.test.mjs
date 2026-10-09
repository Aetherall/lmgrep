import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ContentHash } from "../dist/domain/corpus/ContentHash.js";
import { Vector } from "../dist/domain/corpus/Vector.js";
import { Branch } from "../dist/domain/project/Branch.js";
import { ChunkRepository } from "../dist/infrastructure/lancedb/ChunkRepository.js";
import { FileManifestRepository } from "../dist/infrastructure/lancedb/FileManifestRepository.js";
import { IndexMaintenance } from "../dist/infrastructure/lancedb/IndexMaintenance.js";
import {
	LanceTables,
	TableName,
} from "../dist/infrastructure/lancedb/LanceTables.js";

const branch = Branch.of("main");

const row = (id, fileHash) => ({
	id,
	filePath: "a.ts",
	fileHash,
	startLine: 1,
	endLine: 2,
	type: "function_declaration",
	name: id,
	content: id,
	context: "",
	hash: id,
	vector: [0, 0, 0],
});

function open(t, root) {
	const tables = new LanceTables(root, branch);
	t.after(() => tables.close());
	const manifest = new FileManifestRepository(tables, branch);
	return {
		tables,
		manifest,
		chunks: new ChunkRepository(tables, manifest, branch),
		maintenance: new IndexMaintenance(tables, manifest),
	};
}

function database(t) {
	const root = mkdtempSync(join(tmpdir(), "lmgrep-freshness-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

const ids = async (chunks) =>
	(
		await chunks.search({
			vector: Vector.zeros(3),
			limit: 5,
			scopeToBranch: true,
		})
	)
		.toArray()
		.map((hit) => hit.id);

// What the watcher does from another process: replace a file's chunks and
// record its new version in the manifest.
const WRITER = `
const dist = ${JSON.stringify(new URL("../dist/", import.meta.url).href)};
const { LanceTables, TableName } = await import(dist + "infrastructure/lancedb/LanceTables.js");
const { FileManifestRepository } = await import(dist + "infrastructure/lancedb/FileManifestRepository.js");
const { Branch } = await import(dist + "domain/project/Branch.js");
const { ContentHash } = await import(dist + "domain/corpus/ContentHash.js");
const branch = Branch.of("main");
const tables = new LanceTables(process.argv[1], branch);
const chunks = await tables.table(TableName.Chunks);
await chunks.add([${JSON.stringify(row("v2", "h2"))}]);
await chunks.delete("fileHash = 'h1'");
await new FileManifestRepository(tables, branch).upsert([
	{ path: "a.ts", hash: ContentHash.fromStored("h2") },
]);
tables.close();
`;

test("a reader sees another process's writes after the consistency interval", async (t) => {
	const root = database(t);
	const seed = new LanceTables(root, branch);
	await new FileManifestRepository(seed, branch).upsert([
		{ path: "a.ts", hash: ContentHash.fromStored("h1") },
	]);
	await seed.tableOrCreate(TableName.Chunks, [row("v1", "h1")]);
	seed.close();

	const reader = open(t, root);
	assert.deepEqual(await ids(reader.chunks), ["v1"]);

	execFileSync(process.execPath, ["--input-type=module", "-e", WRITER, root]);
	await sleep(LanceTables.READ_CONSISTENCY_SECONDS * 1000 + 500);

	assert.deepEqual(await ids(reader.chunks), ["v2"]);
});

test("pruning compacts the fragments left by successive writes", async (t) => {
	const { tables, manifest, maintenance } = open(t, database(t));
	await tables.tableOrCreate(TableName.Chunks, [row("first", "h1")]);
	const chunks = await tables.table(TableName.Chunks);
	for (let i = 0; i < 5; i++) await chunks.add([row(`more-${i}`, "h1")]);
	await manifest.upsert([{ path: "a.ts", hash: ContentHash.fromStored("h1") }]);

	const report = await maintenance.prune();
	const chunkReport = report.tables.find((table) => table.table === "chunks");
	assert.ok(chunkReport.fragmentsRemoved >= 6);
	assert.equal(await chunks.countRows(), 6);
	assert.equal((await chunks.stats()).fragmentStats.numFragments, 1);
});

test("checking out the latest version sees another process's writes immediately", async (t) => {
	const root = database(t);
	const seed = new LanceTables(root, branch);
	await new FileManifestRepository(seed, branch).upsert([
		{ path: "a.ts", hash: ContentHash.fromStored("h1") },
	]);
	await seed.tableOrCreate(TableName.Chunks, [row("v1", "h1")]);
	seed.close();

	const reader = open(t, root);
	const stored = async () => [
		...(await reader.chunks.existingHashes([ContentHash.fromStored("v2")])),
	];
	assert.deepEqual(await stored(), []);

	execFileSync(process.execPath, ["--input-type=module", "-e", WRITER, root]);
	await reader.tables.checkoutLatest();

	assert.deepEqual(await stored(), ["v2"]);
});
