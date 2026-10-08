import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TreeSitterChunker } from "../dist/infrastructure/treesitter/TreeSitterChunker.js";

async function chunksOf(t, source, extension = "ts") {
	const root = mkdtempSync(join(tmpdir(), "lmgrep-chunk-quality-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = `example.${extension}`;
	writeFileSync(join(root, file), source);
	return new TreeSitterChunker().chunk(file, root);
}

test("exports retain declaration kinds, names, modifiers and documentation", async (t) => {
	const chunks = await chunksOf(
		t,
		`/** Identifies a user. */
export type UserId = string;
export interface User { id: UserId }
/** Converts a user's name. */
export default function displayName(name: string) {
  return name.toUpperCase();
}
export const enabled = true;
`,
	);
	assert.deepEqual(
		chunks.map((chunk) => [chunk.type, chunk.name]),
		[
			["type_alias_declaration", "UserId"],
			["interface_declaration", "User"],
			["function_declaration", "displayName"],
			["variable_declarator", "enabled"],
		],
	);
	assert.ok(chunks.every((chunk) => chunk.content.startsWith("export ")));
	assert.match(chunks[0].context, /Identifies a user/);
	assert.match(chunks[0].context, /\[role: definition\]/);
	assert.match(chunks[2].context, /Converts a user's name/);
	assert.equal(chunks[2].location.startLine, 5);
});

test("classes yield qualified complete methods and preserve their shape and fields", async (t) => {
	const source = `/** Billing operations. */
export class Billing {
  private balance = 0;
  /** Charges an account. */
  charge(amount: number) {
    this.balance += amount;
    return this.balance;
  }
  private currency = "USD";
  refund(amount: number) {
    this.balance -= amount;
  }
}
`;
	const chunks = await chunksOf(t, source);
	const charge = chunks.find((chunk) => chunk.name === "Billing.charge");
	assert.equal(charge.type, "method_definition");
	assert.equal(
		charge.content,
		"charge(amount: number) {\n    this.balance += amount;\n    return this.balance;\n  }",
	);
	assert.equal(charge.location.startLine, 5);
	assert.equal(charge.location.endLine, 8);
	assert.match(charge.context, /\[scope: class Billing\]/);
	assert.match(charge.context, /Charges an account/);
	assert.match(charge.embeddingText(), /Billing\.charge/);
	assert.ok(chunks.some((chunk) => chunk.name === "Billing.refund"));
	assert.ok(
		chunks.some((chunk) => chunk.content.startsWith("export class Billing")),
	);
	assert.ok(
		chunks.some((chunk) => chunk.content.includes("private balance = 0")),
	);
	assert.ok(
		chunks.some((chunk) => chunk.content.includes('private currency = "USD"')),
	);
	assert.ok(
		chunks.every(
			(chunk) =>
				!chunk.content.includes("charge(amount") ||
				!chunk.content.includes("refund(amount"),
		),
	);
	assert.ok(chunks.every((chunk) => !chunk.name.startsWith("anonymous_")));
});

test("one-line methods and neighboring declarations remain distinct", async (t) => {
	const chunks = await chunksOf(
		t,
		"export class Flags { on() { return true; } off() { return false; } }\nexport type Id = string;\n",
	);
	assert.ok(chunks.some((chunk) => chunk.name === "Flags.on"));
	assert.ok(chunks.some((chunk) => chunk.name === "Flags.off"));
	assert.ok(chunks.some((chunk) => chunk.name === "Id"));
});

test("test chunks preserve descriptive labels and the complete test call", async (t) => {
	const chunks = await chunksOf(
		t,
		`test.only("rejects invalid amounts", () => {
  assert.throws(() => charge(-1));
});
`,
		"mjs",
	);
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0].name, "test.only: rejects invalid amounts");
	assert.ok(
		chunks[0].content.startsWith('test.only("rejects invalid amounts"'),
	);
	assert.ok(chunks[0].content.endsWith("})"));
	assert.match(chunks[0].embeddingText(), /rejects invalid amounts/);
});

test("top-level executable code survives beside parsed functions", async (t) => {
	const chunks = await chunksOf(
		t,
		`echo "initialization configuration"

useful_function() {
  echo "does something useful"
}
useful_function
`,
		"sh",
	);
	assert.ok(
		chunks.some(
			(chunk) => chunk.content === 'echo "initialization configuration"',
		),
	);
	assert.ok(chunks.some((chunk) => chunk.name === "useful_function"));
	assert.ok(chunks.some((chunk) => chunk.content === "useful_function"));
});

test("decorated Python classes expose qualified methods without losing decorators", async (t) => {
	const chunks = await chunksOf(
		t,
		`@registered
class Billing:
    currency = "USD"

    @checked
    def charge(self, amount):
        return amount * 100

    def refund(self, amount):
        return -amount * 100
`,
		"py",
	);
	assert.ok(
		chunks.some((chunk) =>
			chunk.content.startsWith("@registered\nclass Billing:"),
		),
	);
	const charge = chunks.find((chunk) => chunk.name === "Billing.charge");
	assert.equal(charge.type, "function_definition");
	assert.ok(charge.content.startsWith("@checked\n    def charge"));
	assert.match(charge.context, /\[scope: class Billing\]/);
	assert.ok(chunks.some((chunk) => chunk.name === "Billing.refund"));
});

test("UTF-8 source positions and source slices remain accurate", async (t) => {
	const source = `export const label = "😀é";
export class Unicode {
  greet() { return "こんにちは"; }
}
`;
	const chunks = await chunksOf(t, source);
	const greet = chunks.find((chunk) => chunk.name === "Unicode.greet");
	assert.equal(greet.location.startLine, 3);
	assert.equal(greet.location.endLine, 3);
	assert.equal(greet.content, 'greet() { return "こんにちは"; }');
	assert.ok(chunks.every((chunk) => source.includes(chunk.content)));
});

test("Markdown headings stay section boundaries rather than fenced code headings", async (t) => {
	const chunks = await chunksOf(
		t,
		"# Guide\nIntro\n\n## Example\n```sh\n# not a heading\necho hello\n```\n\n## Details\nMore\n",
		"md",
	);
	assert.deepEqual(
		chunks.map((chunk) => chunk.name),
		["Guide", "Example", "Details"],
	);
	assert.ok(chunks[1].content.includes("# not a heading"));
});

test("bound arrow functions retain their binding, export and enclosing class", async (t) => {
	const chunks = await chunksOf(
		t,
		"export const greet = (name: string) => name.toUpperCase();\nexport class Greeter {\n  readonly run = (name: string) => name.toUpperCase();\n}\n",
	);
	const greet = chunks.find((chunk) => chunk.name === "greet");
	assert.equal(greet.type, "arrow_function");
	assert.ok(greet.content.startsWith("export const greet ="));
	const run = chunks.find((chunk) => chunk.name === "Greeter.run");
	assert.equal(run.type, "arrow_function");
	assert.ok(run.content.startsWith("readonly run ="));
	assert.match(run.context, /\[scope: class Greeter\]/);
});

test("top-level control flow keeps uncovered executable code around declarations", async (t) => {
	const chunks = await chunksOf(
		t,
		'if (enabled) {\n  initialize();\n  function runJob() { return "done"; }\n  runJob();\n}\n',
	);
	assert.ok(chunks.some((chunk) => chunk.name === "runJob"));
	assert.ok(chunks.some((chunk) => chunk.content.includes("if (enabled)")));
	assert.ok(chunks.some((chunk) => chunk.content.includes("initialize();")));
	assert.ok(chunks.some((chunk) => chunk.content.includes("runJob();")));
});
