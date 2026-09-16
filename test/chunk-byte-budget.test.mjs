import assert from "node:assert/strict";
import test from "node:test";
import { Chunk } from "../dist/domain/corpus/Chunk.js";
import { CodeLocation } from "../dist/domain/corpus/CodeLocation.js";
import { ContentHash } from "../dist/domain/corpus/ContentHash.js";
import { FileVersion } from "../dist/domain/corpus/FileVersion.js";

function chunk(content) {
	return new Chunk({
		location: new CodeLocation(
			"source.ts",
			3,
			3 + content.split("\n").length - 1,
		),
		type: "function",
		name: "source",
		content,
		context: "file source.ts",
		hash: ContentHash.of(content),
		fileVersion: FileVersion.of(ContentHash.of("source")),
	});
}

test("byte splitting preserves Unicode content, context, version and exact source lines", () => {
	const original = chunk("😀é12\n".repeat(100));
	const prefix = "document: ";
	const parts = original.splitByBytes(64, prefix);
	assert.ok(parts.length > 1);
	assert.equal(parts.map((part) => part.content).join(""), original.content);
	let offset = 0;
	for (const part of parts) {
		assert.ok(Buffer.byteLength(prefix + part.embeddingText()) <= 64);
		assert.equal(part.context, original.context);
		assert.equal(part.fileVersion, original.fileVersion);
		assert.equal(part.hash.toString(), ContentHash.of(part.content).toString());
		assert.equal(
			part.location.startLine,
			3 + original.content.slice(0, offset).split("\n").length - 1,
		);
		offset += part.content.length;
		const end = original.content.slice(0, offset).split("\n").length - 1;
		assert.equal(
			part.location.endLine,
			3 + end - (part.content.endsWith("\n") ? 1 : 0),
		);
		assert.ok(!part.content.includes("�"));
	}
});

test("dense single-line data is bounded without silently truncating it", () => {
	const original = chunk("1,".repeat(6000));
	assert.ok(original.estimatedTokens() < 4096);
	const parts = original.splitByBytes(4096);
	assert.ok(parts.length > 1);
	assert.equal(parts.map((part) => part.content).join(""), original.content);
	assert.ok(
		parts.every(
			(part) => part.location.startLine === 3 && part.location.endLine === 3,
		),
	);
	assert.ok(
		parts.every((part) => Buffer.byteLength(part.embeddingText()) <= 4096),
	);
});

test("fitting chunks keep identity and impossible context budgets fail explicitly", () => {
	const original = chunk("return true;");
	assert.equal(original.splitByBytes(100)[0], original);
	assert.throws(
		() => original.splitByBytes(4),
		/context exceeds the byte budget/,
	);
});
