import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { IndexableFileRules } from "../dist/infrastructure/fs/IndexableFileRules.js";
import { LanguageCatalog } from "../dist/infrastructure/treesitter/LanguageCatalog.js";
import { TreeSitterChunker } from "../dist/infrastructure/treesitter/TreeSitterChunker.js";

for (const [extension, language] of [
	[".mjs", "javascript"],
	[".cjs", "javascript"],
	[".mts", "typescript"],
	[".cts", "typescript"],
]) {
	test(`${extension} is indexed and parsed into named functions`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "lmgrep-module-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const path = `example${extension}`;
		const annotation = language === "typescript" ? ": string" : "";
		writeFileSync(join(root, path), `function describeModule(value${annotation}) {\n  return "module description: " + value.toUpperCase();\n}\n`);
		assert.equal(new IndexableFileRules(root).admits(path), true);
		assert.equal(new LanguageCatalog().forFile(path)?.id, language);
		const chunks = await new TreeSitterChunker().chunk(path, root);
		assert.ok(chunks.some((chunk) => chunk.name === "describeModule" && chunk.type === "function_declaration"));
		assert.ok(chunks.every((chunk) => chunk.type !== "block"));
		assert.equal(new IndexableFileRules(root, [path]).admits(path), false);
		assert.equal(new IndexableFileRules(root, [], { exclude: [extension] }).admits(path), false);
	});
}
