import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BranchManifestSweeper } from "../dist/application/indexing/BranchManifestSweeper.js";
import { ContentHash } from "../dist/domain/corpus/ContentHash.js";
import { Branch } from "../dist/domain/project/Branch.js";
import { ModelIdentity } from "../dist/domain/project/ModelIdentity.js";
import { ProjectLocator } from "../dist/domain/project/ProjectLocator.js";
import { SilentLogger } from "../dist/infrastructure/fs/Loggers.js";
import { StateDirectory } from "../dist/infrastructure/fs/StateDirectory.js";
import { GitClient } from "../dist/infrastructure/git/GitClient.js";
import { FileManifestRepository } from "../dist/infrastructure/lancedb/FileManifestRepository.js";
import { LanceTables } from "../dist/infrastructure/lancedb/LanceTables.js";

const git = (cwd, ...args) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		cwd,
		stdio: "pipe",
	})
		.toString()
		.trim();

function repository(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "lmgrep-detached-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const main = join(root, "main");
	execFileSync("git", ["init", "-q", "-b", "main", main]);
	writeFileSync(join(main, "a.ts"), "export {};\n");
	git(main, "add", ".");
	git(main, "commit", "-qm", "init");
	const detachedA = join(root, "detached-a");
	const detachedB = join(root, "detached-b");
	git(main, "worktree", "add", "-q", "--detach", detachedA);
	git(main, "worktree", "add", "-q", "--detach", detachedB);
	return { root, main, detachedA, detachedB };
}

const locator = (root) =>
	new ProjectLocator(
		new GitClient(),
		new StateDirectory(join(root, "state")),
		ModelIdentity.of("openai:test"),
	);

test("each detached worktree gets its own branch scope", (t) => {
	const { root, main, detachedA, detachedB } = repository(t);
	const scopes = [main, detachedA, detachedB].map((cwd) =>
		locator(root).resolveProject(cwd).branch.toString(),
	);
	assert.deepEqual(scopes, [
		"main",
		Branch.detachedAt(detachedA).toString(),
		Branch.detachedAt(detachedB).toString(),
	]);
});

test("the sweeper keeps detached scopes until their worktree leaves detached HEAD", async (t) => {
	const { root, main, detachedA, detachedB } = repository(t);
	const tables = new LanceTables(join(root, "db"), Branch.of("main"));
	t.after(() => tables.close());
	const scopes = [
		"main",
		"HEAD",
		...[detachedA, detachedB].map((path) => Branch.detachedAt(path).toString()),
	];
	for (const scope of scopes) {
		await new FileManifestRepository(tables, Branch.of(scope)).upsert([
			{ path: "a.ts", hash: ContentHash.fromStored("h") },
		]);
	}
	const manifest = new FileManifestRepository(tables, Branch.of("main"));
	const sweeper = new BranchManifestSweeper(
		manifest,
		new GitClient(),
		new SilentLogger(),
	);

	await sweeper.sweep(main);
	assert.deepEqual(
		(await manifest.storedBranches()).sort(),
		[scopes[0], scopes[2], scopes[3]].sort(),
	);

	git(detachedA, "checkout", "-q", "-b", "feature");
	git(main, "worktree", "remove", detachedB);
	await sweeper.sweep(main);
	assert.deepEqual((await manifest.storedBranches()).sort(), ["main"]);
});
