import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Workspace } from "../dist/infrastructure/fs/Workspace.js";

const DEBOUNCE_MS = 50;

function watched(t) {
	const root = mkdtempSync(join(tmpdir(), "lmgrep-watch-"));
	mkdirSync(join(root, "src", "deep"), { recursive: true });
	mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
	writeFileSync(join(root, "src", "deep", "existing.ts"), "export {};\n");
	const batches = [];
	const handle = new Workspace().watch(
		root,
		undefined,
		(files) => batches.push(files),
		DEBOUNCE_MS,
	);
	t.after(() => {
		handle.close();
		rmSync(root, { recursive: true, force: true });
	});
	const settle = async () => {
		await sleep(DEBOUNCE_MS * 4);
		const files = new Set(batches.flat());
		batches.length = 0;
		return files;
	};
	return { root, settle };
}

test("edits, creations and deletions in nested directories are reported", async (t) => {
	const { root, settle } = watched(t);
	writeFileSync(
		join(root, "src", "deep", "existing.ts"),
		"export const a = 1;\n",
	);
	writeFileSync(join(root, "src", "added.ts"), "export {};\n");
	assert.deepEqual(
		await settle(),
		new Set(["src/deep/existing.ts", "src/added.ts"]),
	);

	unlinkSync(join(root, "src", "added.ts"));
	assert.deepEqual(await settle(), new Set(["src/added.ts"]));
});

test("directories created after the watch starts are watched too", async (t) => {
	const { root, settle } = watched(t);
	mkdirSync(join(root, "src", "later"));
	await settle();
	writeFileSync(join(root, "src", "later", "file.ts"), "export {};\n");
	assert.deepEqual(await settle(), new Set(["src/later/file.ts"]));
});

test("ignored directories and non-source files are not reported", async (t) => {
	const { root, settle } = watched(t);
	writeFileSync(join(root, "node_modules", "pkg", "index.ts"), "export {};\n");
	writeFileSync(join(root, "src", "image.png"), "");
	mkdirSync(join(root, "node_modules", "pkg", "nested"));
	await settle();
	writeFileSync(join(root, "node_modules", "pkg", "nested", "x.ts"), "");
	assert.deepEqual(await settle(), new Set());
});
