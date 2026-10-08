import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";
import { ContentHash } from "../dist/domain/corpus/ContentHash.js";
import { FileVersion } from "../dist/domain/corpus/FileVersion.js";
import { Hit } from "../dist/domain/retrieval/Hit.js";
import { TreeSitterChunker } from "../dist/infrastructure/treesitter/TreeSitterChunker.js";
import { CommandContext } from "../dist/presentation/cli/CommandContext.js";
import { SearchCommand } from "../dist/presentation/cli/commands/SearchCommand.js";
import { Renderer } from "../dist/presentation/cli/Renderer.js";
import { HitPresentation } from "../dist/presentation/HitPresentation.js";
import { HitFormatter } from "../dist/presentation/mcp/HitFormatter.js";
import { ToolDescriptions } from "../dist/presentation/mcp/ToolDescriptions.js";

async function corpus(
	t,
	source = `/** Handles requests. */
export class Service {
  private enabled = true;
  run() { return "primary implementation"; }
  stop() { return "secondary implementation"; }
  readonly restart = () => "restart implementation";
}
export class Other {
  run() { return "other implementation"; }
}
`,
) {
	const root = mkdtempSync(join(tmpdir(), "lmgrep-lean-hits-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "service.ts"), source);
	const chunks = await new TreeSitterChunker().chunk("service.ts", root);
	const version = FileVersion.of(ContentHash.of(source));
	return (names) =>
		names.map((selection, i) => {
			const [name, occurrence] = Array.isArray(selection)
				? selection
				: [selection, 0];
			const chunk = chunks.filter((item) => item.name === name)[occurrence];
			assert.ok(chunk, `Missing real chunk ${name}`);
			return new Hit(
				chunk.id,
				chunk.location,
				chunk.type,
				chunk.name,
				chunk.content,
				chunk.context,
				1 - i / 10,
				version,
			);
		});
}

test("default cards keep one ranked primary per class without supplementary bodies", async (t) => {
	const select = await corpus(t);
	const hits = select(["Service.run", "Service.stop", "Other.run", "Service"]);
	const before = JSON.stringify(hits);
	const cards = HitPresentation.cards(hits);
	assert.equal(cards.length, 2);
	assert.match(cards[0], /Service\.run \[method\]/);
	assert.match(cards[0], /primary implementation/);
	assert.match(cards[0], /Related: Service\.stop/);
	assert.match(cards[0], /1 additional class matches omitted/);
	assert.doesNotMatch(
		cards[0],
		/secondary implementation|Class doc:|Declaration\/state:/,
	);
	assert.match(cards[1], /Other\.run/);
	assert.equal(JSON.stringify(hits), before);
});

test("optional class context quotes retrieved state and docs and links related members", async (t) => {
	const select = await corpus(t);
	const hits = select([
		"Service.run",
		"Service",
		"Service.stop",
		"Service.restart",
	]);
	const text = HitFormatter.hits(hits, true);
	assert.match(text, /Class: Service · service\.ts:2-3/);
	assert.match(text, /Declaration\/state: export class Service \{/);
	assert.match(text, /Class doc: Handles requests\./);
	assert.match(text, /Related: Service\.stop · service\.ts:5-5/);
	assert.match(text, /Related: Service\.restart · service\.ts:6-6/);
	assert.doesNotMatch(text, /secondary implementation|restart implementation/);
	assert.equal(text.match(/primary implementation/g)?.length, 1);
	assert.doesNotMatch(text, /\[(?:file|role|symbol):/);
});

test("a stronger class declaration remains primary, with the method linked not boosted", async (t) => {
	const select = await corpus(t);
	const text = HitFormatter.hits(select(["Service", "Service.run"]), true);
	assert.match(text.split("\n")[0], /· Service \[class\]/);
	assert.match(text, /Related: Service\.run/);
	assert.doesNotMatch(text, /primary implementation/);
});

test("context does not invent declarations or fetch other source when none was retrieved", async (t) => {
	const select = await corpus(t);
	const text = HitFormatter.hits(select(["Service.run", "Service.stop"]), true);
	assert.match(text, /Related: Service\.stop/);
	assert.doesNotMatch(
		text,
		/Class:|Class doc:|Declaration\/state:|private enabled/,
	);
});

test("namespaces, files and file versions never merge unrelated classes", async (t) => {
	const select = await corpus(
		t,
		'namespace A { export class Service { run() { return "a"; } } }\nnamespace B { export class Service { run() { return "b"; } } }\n',
	);
	const hits = select([
		["Service.run", 0],
		["Service.run", 1],
	]);
	assert.equal(HitPresentation.cards(hits).length, 2);
	const original = hits[0];
	const relocated = original.relocatedUnder("/other-project");
	const version = new Hit(
		"different-version",
		original.location,
		original.type,
		original.name,
		original.content,
		original.context,
		0.5,
		FileVersion.fromStored("different"),
	);
	assert.equal(HitPresentation.cards([original, relocated, version]).length, 3);
});

test("conflicting class declarations retain original hit order rather than collapsing", async (t) => {
	const select = await corpus(
		t,
		'namespace A { export class Service { run() { return "a"; } } }\nnamespace B { export class Service { stop() { return "b"; } } }\n',
	);
	const hits = select([
		"Service.run",
		["Service", 0],
		"Service.stop",
		["Service", 1],
	]);
	assert.deepEqual(
		HitPresentation.cards(hits),
		hits.map((hit) => HitPresentation.format(hit)),
	);
});

test("top-level functions remain separate and CLI/MCP use the same cards", async (t) => {
	const select = await corpus(
		t,
		'export function first() { return "first"; }\nexport function second() { return "second"; }\n',
	);
	const hits = select(["first", "second"]);
	const cards = HitPresentation.cards(hits, true);
	assert.equal(cards.length, 2);
	assert.equal(HitFormatter.hits(hits, true), cards.join("\n\n---\n\n"));
	const output = [];
	new Renderer((line) => output.push(line)).hits(hits, true);
	assert.deepEqual(
		output.filter((_, i) => i % 2 === 1),
		cards,
	);
});

test("class snippets are compact and omissions retain their source locations", async (t) => {
	const fields = Array.from(
		{ length: 40 },
		(_, i) => `  private field${i} = ${i};`,
	).join("\n");
	const select = await corpus(
		t,
		`export class Large {\n${fields}\n  run() { return "primary implementation"; }\n}\n`,
	);
	const text = HitFormatter.hits(select(["Large", "Large.run"]), true);
	assert.equal(
		text.split("\n").filter((line) => /^\s*\d+ \|/.test(line)).length,
		11,
	);
	assert.match(text, /30 source lines omitted \(service\.ts:12-41\)/);
	assert.match(text, /Related: Large\.run/);
});

test("related links and large primary source stay within shared output budgets", async (t) => {
	const methods = Array.from(
		{ length: 8 },
		(_, i) => `  member${i}() { return "secondary implementation ${i}"; }`,
	).join("\n");
	const body = Array.from(
		{ length: 100 },
		() => `    process("${"x".repeat(1000)}");`,
	).join("\n");
	const select = await corpus(
		t,
		`/** ${"doc ".repeat(6000)} */\nexport class Large {\n  run() {\n${body}\n  }\n${methods}\n}\n`,
	);
	const names = [
		"Large.run",
		"Large",
		...Array.from({ length: 8 }, (_, i) => `Large.member${i}`),
	];
	const text = HitFormatter.hits(select(names), true);
	assert.ok(text.length <= HitPresentation.MAX_CHARACTERS);
	assert.ok(text.split("\n").length <= HitPresentation.MAX_LINES);
	assert.equal(text.match(/^Related:/gm)?.length, 3);
	assert.match(text, /5 additional class matches omitted/);
	assert.match(text, /Class doc:|context lines omitted/);
	assert.match(text, /output characters omitted/);
	assert.match(text, /source lines omitted/);
	assert.doesNotMatch(text, /secondary implementation/);
});

test("CLI optional context and MCP optional context are registered without inference", () => {
	const program = new Command();
	new SearchCommand(new CommandContext()).register(program);
	const search = program.commands.find(
		(command) => command.name() === "search",
	);
	assert.ok(search.options.some((option) => option.long === "--context"));
	search.parseOptions(["--context"]);
	assert.equal(search.opts().context, true);
	assert.match(
		ToolDescriptions.SEARCH_PARAMS.classContext.description,
		/retrieved hits/,
	);
});
