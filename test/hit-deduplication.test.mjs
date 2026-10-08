import assert from "node:assert/strict";
import test from "node:test";
import { Chunk } from "../dist/domain/corpus/Chunk.js";
import { CodeLocation } from "../dist/domain/corpus/CodeLocation.js";
import { ContentHash } from "../dist/domain/corpus/ContentHash.js";
import { FileVersion } from "../dist/domain/corpus/FileVersion.js";
import { Hit } from "../dist/domain/retrieval/Hit.js";
import { HitList } from "../dist/domain/retrieval/HitList.js";

function hit(id, start, end, content, file = "source.ts") {
	return new Hit(
		id,
		new CodeLocation(file, start, end),
		"block",
		id,
		content,
		"",
		1,
		FileVersion.unknown(),
	);
}

test("exact duplicates and wholly redundant contained source are removed", () => {
	const parent = hit("parent", 1, 3, "first\nsecond\nthird");
	const child = hit("child", 2, 2, "second");
	assert.deepEqual(
		HitList.of([parent, parent, child]).deduplicated().toArray(),
		[parent],
	);
});

test("partial overlaps retain complementary code and distinct same-line declarations", () => {
	const hits = [
		hit("first", 1, 3, "first\nsecond\nthird"),
		hit("second", 3, 5, "third\nfourth\nfifth"),
		hit("inline-1", 6, 6, "on() { return true; }"),
		hit("inline-2", 6, 6, "off() { return false; }"),
	];
	assert.deepEqual(HitList.of(hits).deduplicated().toArray(), hits);
});

test("identical content in distinct files remains searchable", () => {
	const hits = [
		hit("a", 1, 1, "export const enabled = true;", "a.ts"),
		hit("b", 1, 1, "export const enabled = true;", "b.ts"),
	];
	assert.equal(HitList.of(hits).deduplicated().length, 2);
});

test("byte-bounded fragments on the same source line survive deduplication", () => {
	const content = "abcdefghijklmnopqrstuvwxyz0123456789";
	const chunk = new Chunk({
		location: new CodeLocation("source.ts", 1, 1),
		type: "block",
		name: "dense",
		content,
		context: "",
		hash: ContentHash.of(content),
	});
	const hits = chunk
		.splitByBytes(12)
		.map(
			(part) =>
				new Hit(
					part.id,
					part.location,
					part.type,
					part.name,
					part.content,
					part.context,
					1,
					part.fileVersion,
				),
		);
	assert.ok(hits.length > 1);
	assert.equal(
		HitList.of(hits)
			.deduplicated()
			.toArray()
			.map((part) => part.content)
			.join(""),
		content,
	);
});
