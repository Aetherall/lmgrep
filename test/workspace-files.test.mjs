import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Workspace } from "../dist/infrastructure/fs/Workspace.js";

function tree(t, files) {
	const root = mkdtempSync(join(tmpdir(), "lmgrep-files-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

test("listing honours root, nested and default ignores without entering ignored trees", (t) => {
	const root = tree(t, {
		".gitignore": "generated/\n",
		"src/a.ts": "",
		"src/image.png": "",
		"generated/out.ts": "",
		"node_modules/pkg/index.ts": "",
		"packages/web/.gitignore": "cache/\n*.gen.ts\n",
		"packages/web/src/b.ts": "",
		"packages/web/src/c.gen.ts": "",
		"packages/web/cache/d.ts": "",
		".github/workflow.yml": "",
		".hidden.ts": "",
	});
	assert.deepEqual(new Workspace().listFiles(root), [
		"packages/web/src/b.ts",
		"src/a.ts",
	]);
});

test("symlinks are listed as files and never followed", (t) => {
	const root = tree(t, { "real/a.ts": "", "real/sub/b.ts": "" });
	symlinkSync(join(root, "real", "a.ts"), join(root, "alias.ts"));
	symlinkSync(join(root, "real"), join(root, "linked.ts"));
	assert.deepEqual(new Workspace().listFiles(root), [
		"alias.ts",
		"linked.ts",
		"real/a.ts",
		"real/sub/b.ts",
	]);
});

test("extra ignore patterns and extension rules apply", (t) => {
	const root = tree(t, {
		"src/a.ts": "",
		"src/legacy/b.ts": "",
		"docs/c.md": "",
		"data/d.custom": "",
	});
	assert.deepEqual(
		new Workspace().listFiles(root, ["src/legacy"], {
			include: [".custom"],
			exclude: [".md"],
		}),
		["data/d.custom", "src/a.ts"],
	);
});
