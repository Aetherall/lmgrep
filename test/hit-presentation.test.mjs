import assert from "node:assert/strict";
import test from "node:test";
import { Chunk } from "../dist/domain/corpus/Chunk.js";
import { CodeLocation } from "../dist/domain/corpus/CodeLocation.js";
import { ContentHash } from "../dist/domain/corpus/ContentHash.js";
import { FileVersion } from "../dist/domain/corpus/FileVersion.js";
import { Hit } from "../dist/domain/retrieval/Hit.js";
import { Renderer } from "../dist/presentation/cli/Renderer.js";
import { HitPresentation } from "../dist/presentation/HitPresentation.js";
import { HitFormatter } from "../dist/presentation/mcp/HitFormatter.js";

test("qualified symbols appear only in the hit header", () => {
	const text = HitFormatter.hits([
		hit({
			name: "Service.handle",
			context:
				"[file: src/service.ts]\n[role: implementation]\n[symbol: Service.handle]\n[scope: class Service]\n[doc: Handles requests.]",
		}),
	]);
	assert.equal(text.match(/Service\.handle/g)?.length, 1);
	assert.match(text, /Scope: class Service\nDoc: Handles requests\./);
	assert.doesNotMatch(text, /\[(?:file|role|symbol):/);
});

test("single-line generated fallback names use the file name", () => {
	assert.match(
		HitFormatter.hits([
			hit({
				name: "lines_123",
				type: "block",
				content: "plain text",
				context: "",
			}),
		]),
		/· service\.ts \[block\]/,
	);
});

test("real byte-split chunks do not gain synthetic trailing source lines", () => {
	const content = "first\n\nthird\nfourth\n";
	const chunk = new Chunk({
		location: new CodeLocation("src/service.ts", 20, 23),
		type: "block",
		name: "lines_20",
		content,
		context: "",
		hash: ContentHash.of(content),
		fileVersion: FileVersion.fromStored("version-1"),
	});
	const parts = chunk.splitByBytes(14);
	assert.ok(parts.length > 1);
	const rendered = [];
	for (const part of parts) {
		const value = new Hit(
			part.id,
			part.location,
			part.type,
			part.name,
			part.content,
			part.context,
			0.875,
			part.fileVersion,
		);
		const source = HitFormatter.hits([value]).split("\n").slice(1);
		assert.equal(
			source.length,
			part.location.endLine - part.location.startLine + 1,
		);
		rendered.push(...source);
	}
	assert.deepEqual(rendered, [
		"20 | first",
		"21 | ",
		"22 | third",
		"23 | fourth",
	]);
	assert.equal(
		HitFormatter.hits([hit({ content: "a\r\n\r\n", end: 21, context: "" })])
			.split("\n")
			.slice(1)
			.join("\n"),
		"20 | a\n21 | ",
	);
});

test("huge source, symbol and documentation have exact character omission notices", () => {
	for (const options of [
		{ content: "x".repeat(30_000), context: "" },
		{ name: "x".repeat(30_000), context: "" },
		{ context: `[doc: ${"x".repeat(30_000)}]` },
	]) {
		const value = hit(options);
		const text = HitFormatter.hits([value]);
		assert.ok(text.length <= HitPresentation.MAX_CHARACTERS);
		assert.ok(text.split("\n").length <= HitPresentation.MAX_LINES);
		const match = text.match(
			/\n… (\d+) output characters omitted \(src\/service\.ts:20-\d+\)$/,
		);
		assert.ok(match);
		const original = [
			`${value.location} · ${value.name} [function] (score: 0.875)`,
			...(options.context?.startsWith("[doc:")
				? [`Doc: ${"x".repeat(30_000)}`]
				: []),
			...value.content.split("\n").map((line, i) => `${20 + i} | ${line}`),
		].join("\n");
		const prefix = text.slice(0, match.index);
		assert.ok(original.startsWith(prefix));
		assert.equal(Number(match[1]), original.length - prefix.length);
	}
});

test("character clipping retains line omission notices and bounds huge locations", () => {
	const text = HitFormatter.hits([
		hit({
			content: Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n"),
			context: `[doc: ${Array.from({ length: 30 }, () => "doc").join("\n")}]`,
		}),
	]);
	assert.ok(text.length <= HitPresentation.MAX_CHARACTERS);
	assert.ok(text.split("\n").length <= HitPresentation.MAX_LINES);
	assert.match(text, /output characters omitted \(src\/service\.ts:20-119\)/);
	assert.match(text, /18 context lines omitted/);
	assert.match(text, /35 source lines omitted \(src\/service\.ts:85-119\)/);
	const value = new Hit(
		"large-path",
		new CodeLocation("x".repeat(30_000), 1, 1),
		"block",
		"lines_1",
		"text",
		"",
		0.5,
		FileVersion.unknown(),
	);
	const hugePath = HitFormatter.hits([value]);
	assert.ok(hugePath.length <= HitPresentation.MAX_CHARACTERS);
	assert.match(hugePath, /location characters omitted/);
	const rawContext = HitFormatter.hits([
		hit({ context: `… ${"x".repeat(30_000)}` }),
	]);
	assert.ok(rawContext.length <= HitPresentation.MAX_CHARACTERS);
	assert.match(rawContext, /output characters omitted/);
});

function hit(options = {}) {
	const content = options.content ?? "function handle() {\n  return true;\n}";
	const start = options.start ?? 20;
	return new Hit(
		"hit-1",
		new CodeLocation(
			"src/service.ts",
			start,
			options.end ?? start + content.split(/\r?\n/).length - 1,
		),
		options.type ?? "function_declaration",
		options.name ?? "handle",
		content,
		options.context ??
			"[file: src/service.ts]\n[role: implementation]\n[scope: class Service]\n[doc: /** Handles [requests].\n * Keeps documentation. */]",
		0.875,
		FileVersion.fromStored("version-1"),
	);
}

test("CLI and MCP share readable headers, numbered source, scope and doc", () => {
	const value = hit();
	const expected = [
		"src/service.ts:20-22 · handle [function] (score: 0.875)",
		"Scope: class Service",
		"Doc: /** Handles [requests].",
		" * Keeps documentation. */",
		"20 | function handle() {",
		"21 |   return true;",
		"22 | }",
	].join("\n");
	assert.equal(HitFormatter.hits([value]), expected);
	const output = [];
	new Renderer((line) => output.push(line)).hits([value]);
	assert.equal(output[1], expected);
	assert.doesNotMatch(expected, /\[file:|\[role:|function_declaration/);
});

test("anonymous wrappers use declarations or bindings, never nested symbols", () => {
	for (const [type, content, name, kind] of [
		[
			"export_statement",
			"export async function fetchData() {\n}",
			"fetchData",
			"export",
		],
		[
			"export_statement",
			"export const worker = () => {\nfunction nested() {}\n};",
			"worker",
			"export",
		],
		[
			"decorated_definition",
			"@cached\ndef fetch_data():\n    pass",
			"fetch_data",
			"decorated definition",
		],
	]) {
		const text = HitFormatter.hits([
			hit({ type, content, name: "anonymous_19", context: "" }),
		]);
		assert.match(text.split("\n")[0], new RegExp(`· ${name} \\[${kind}\\]`));
		assert.doesNotMatch(text, /anonymous_19/);
	}
	assert.match(
		HitFormatter.hits([
			hit({
				name: "anonymous_19",
				type: "arrow_function",
				content: "() => {\nfunction nested() {}\n}",
			}),
		]),
		/· \(unnamed\) \[function\]/,
	);
});

test("text windows use the file name rather than a generated line name", () => {
	assert.match(
		HitFormatter.hits([
			hit({
				type: "block",
				name: "lines_20_22",
				content: "plain text",
				context: "[file: src/service.ts]",
			}),
		]),
		/· service\.ts \[block\]/,
	);
});

test("large source is bounded with an exact omitted count and source location", () => {
	const value = hit({
		content: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
		context: "",
	});
	const lines = HitFormatter.hits([value]).split("\n");
	assert.equal(lines.length, HitPresentation.MAX_LINES);
	assert.equal(lines[1], " 20 | line 0");
	assert.equal(lines.at(-2), " 97 | line 77");
	assert.equal(
		lines.at(-1),
		"… 22 source lines omitted (src/service.ts:98-119)",
	);
});

test("oversized documentation is explicitly bounded and leaves room for source", () => {
	const context = `[file: src/service.ts]\n[role: implementation]\n[scope: class Service]\n[doc: ${Array.from({ length: 30 }, (_, i) => `doc ${i}`).join("\n")}]`;
	const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
	const lines = HitFormatter.hits([hit({ context, content })]).split("\n");
	assert.equal(lines.length, 80);
	assert.equal(lines[13], "… 19 context lines omitted (src/service.ts:20-119)");
	assert.equal(
		lines.at(-1),
		"… 35 source lines omitted (src/service.ts:85-119)",
	);
	assert.ok(lines.includes(" 20 | line 0"));
});

test("exact budget, CRLF, trailing blank lines and empty hits are handled", () => {
	const content = Array.from({ length: 79 }, () => "text").join("\n");
	const text = HitFormatter.hits([hit({ content, context: "" })]);
	assert.equal(text.split("\n").length, 80);
	assert.doesNotMatch(text, /omitted/);
	assert.equal(
		HitFormatter.hits([hit({ content: "a\r\nb\r\n", context: "" })])
			.split("\n")
			.slice(1)
			.join("\n"),
		"20 | a\n21 | b\n22 | ",
	);
	assert.equal(
		HitFormatter.hits([hit({ content: "", context: "" })]).split("\n").length,
		1,
	);
	assert.equal(HitFormatter.hits([]), "");
});

test("multiple hits retain separation and compact paths and JSON are unchanged", () => {
	const value = hit();
	const before = JSON.stringify(value);
	assert.equal(
		HitFormatter.hits([value, value]),
		`${HitPresentation.format(value)}\n\n---\n\n${HitPresentation.format(value)}`,
	);
	const output = [];
	const renderer = new Renderer((line) => output.push(line));
	renderer.hitPaths([value, value]);
	assert.deepEqual(output, ["src/service.ts"]);
	renderer.json([value]);
	assert.equal(output[1], JSON.stringify([value], null, 2));
	assert.equal(JSON.stringify(value), before);
});
