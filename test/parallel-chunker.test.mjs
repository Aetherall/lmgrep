import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { ParallelChunker } from "../dist/infrastructure/treesitter/ParallelChunker.js";
import { TreeSitterChunker } from "../dist/infrastructure/treesitter/TreeSitterChunker.js";

const root = join(import.meta.dirname, "..");

function sourceFiles() {
	return readdirSync(join(root, "src"), {
		recursive: true,
		withFileTypes: true,
	})
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => relative(root, join(entry.parentPath, entry.name)))
		.sort();
}

function plain(chunks) {
	return chunks.map((chunk) => ({
		location: chunk.location.toString(),
		type: chunk.type,
		name: chunk.name,
		content: chunk.content,
		context: chunk.context,
		hash: chunk.hash.toString(),
	}));
}

test("worker threads produce exactly the in-process chunks, concurrently", async (t) => {
	const parallel = new ParallelChunker(2);
	t.after(() => parallel.close());
	const local = new TreeSitterChunker();
	const files = sourceFiles();
	const [threaded, inProcess] = await Promise.all([
		Promise.all(files.map((file) => parallel.chunk(file, root))),
		Promise.all(files.map((file) => local.chunk(file, root))),
	]);
	assert.ok(files.length > 50);
	assert.deepEqual(threaded.map(plain), inProcess.map(plain));
});

test("a pool whose workers cannot start still chunks every file in-process", async (t) => {
	const broken = new ParallelChunker(
		2,
		new URL("file:///nonexistent/ChunkWorker.js"),
	);
	t.after(() => broken.close());
	const files = sourceFiles().slice(0, 10);
	const chunks = await Promise.all(
		files.map((file) => broken.chunk(file, root)),
	);
	const expected = await Promise.all(
		files.map((file) => new TreeSitterChunker().chunk(file, root)),
	);
	assert.deepEqual(chunks.map(plain), expected.map(plain));
});

test("worker failures on a file reject that file only", async (t) => {
	const parallel = new ParallelChunker(1);
	t.after(() => parallel.close());
	await assert.rejects(parallel.chunk("does-not-exist.ts", root), /ENOENT/);
	assert.ok((await parallel.chunk("src/index.ts", root)).length > 0);
});

test("line numbers stay exact deep into a large generated file", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "lmgrep-parallel-chunker-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const count = 5000;
	let source = "";
	for (let i = 0; i < count; i++) {
		source += `export function fn${i}(a: number): number {\n  return a + ${i};\n}\n\n`;
	}
	writeFileSync(join(dir, "generated.ts"), source);
	const chunks = await new TreeSitterChunker().chunk("generated.ts", dir);
	assert.equal(chunks.length, count);
	for (const i of [0, 1, 2500, count - 1]) {
		assert.equal(chunks[i].name, `fn${i}`);
		assert.equal(chunks[i].location.startLine, i * 4 + 1);
		assert.equal(chunks[i].location.endLine, i * 4 + 3);
	}
});
