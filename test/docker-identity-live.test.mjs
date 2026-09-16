import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LmgrepFactory } from "../dist/application/LmgrepFactory.js";
import { SilentLogger } from "../dist/infrastructure/fs/Loggers.js";
import { ProjectMetadataStore } from "../dist/infrastructure/fs/ProjectMetadataStore.js";

const model = process.env.LMGREP_TEST_DOCKER_MODEL;

test("real Docker indexing survives tag-to-digest alias changes without re-embedding", {
	skip:
		!model &&
		"Set LMGREP_TEST_DOCKER_MODEL to an installed Docker embedding model",
	timeout: 120_000,
}, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "lmgrep-docker-live-"));
	const previous = {
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		LMGREP_STATE_DIR: process.env.LMGREP_STATE_DIR,
	};
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	process.env.XDG_CONFIG_HOME = join(root, "config");
	process.env.LMGREP_STATE_DIR = join(root, "state");
	const config = {
		model,
		baseURL:
			process.env.LMGREP_TEST_DOCKER_URL ?? "http://localhost:12434/engines/v1",
		provider: "@ai-sdk/openai-compatible",
		batchSize: 1,
		local: true,
		queryPrefix: "",
		documentPrefix: "",
	};
	mkdirSync(join(root, "config", "lmgrep"), { recursive: true });
	writeFileSync(
		join(root, "config", "lmgrep", "config.yml"),
		JSON.stringify(config),
	);
	const cwd = join(root, "project");
	mkdirSync(cwd);
	writeFileSync(
		join(cwd, "arithmetic.ts"),
		"export function addNumbers(left: number, right: number): number {\n  return left + right;\n}\n",
	);
	const factory = new LmgrepFactory();
	const first = await factory.open({ cwd, logger: new SilentLogger() });
	let path;
	let stored;
	try {
		path = first.location.path;
		const built = await first.build({ files: ["arithmetic.ts"] });
		assert.equal(built.failed, 0);
		assert.ok(built.succeeded > 0);
		stored = new ProjectMetadataStore().read(path);
		assert.match(
			stored.embeddingProfile.artifact,
			/^docker:sha256:[a-f0-9]{64}$/,
		);
		assert.ok(stored.dimensions > 0);
	} finally {
		await first.close();
	}
	const renamed = await factory.open({
		cwd,
		config: { model: stored.embeddingProfile.artifact },
		logger: new SilentLogger(),
	});
	try {
		assert.equal(renamed.location.path, path);
		const built = await renamed.build({ files: ["arithmetic.ts"] });
		assert.equal(built.succeeded, 0);
		assert.equal(built.failed, 0);
		const hits = await renamed.search("add two numbers", { limit: 1 });
		assert.equal(hits.length, 1);
		assert.equal(hits.toArray()[0].location.filePath, "arithmetic.ts");
		assert.equal((await renamed.status()).verdict.searchable, true);
	} finally {
		await renamed.close();
	}
	const changed = await factory.open({
		cwd,
		config: { documentPrefix: "different: " },
		logger: new SilentLogger(),
	});
	try {
		assert.notEqual(changed.location.path, path);
		assert.equal(changed.isIndexed(), false);
	} finally {
		await changed.close();
	}
	await assert.rejects(
		factory.open({
			cwd,
			database: path,
			config: { queryPrefix: "different: " },
		}),
		/do not match/,
	);
});
