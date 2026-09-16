import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EmbeddingProfile } from "../dist/domain/project/EmbeddingProfile.js";
import { ModelIdentity } from "../dist/domain/project/ModelIdentity.js";
import { ProjectLocator } from "../dist/domain/project/ProjectLocator.js";
import { DockerModelIdentityResolver } from "../dist/infrastructure/ai/DockerModelIdentityResolver.js";
import { ProjectMetadataStore } from "../dist/infrastructure/fs/ProjectMetadataStore.js";
import { StateDirectory } from "../dist/infrastructure/fs/StateDirectory.js";
import { VerifiedIndexPath } from "../dist/infrastructure/fs/VerifiedIndexPath.js";
import { GitClient } from "../dist/infrastructure/git/GitClient.js";

const oldName = "docker:docker.io/lmgrep/qwen3-embedding-4b:ctx8k";
const newName =
	"docker:docker.io/ai/text-embedding-qwen3-embedding-4b:q4_k_m-ctx8k";
const digest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"b".repeat(64)}`;
const config = { model: oldName, batchSize: 1 };
const resolver = new DockerModelIdentityResolver();
const catalog = [{ id: digest, tags: [oldName.slice(7), newName.slice(7)] }];
const profile = resolver.fromCatalog(config, catalog);

function temporary(t) {
	const root = mkdtempSync(join(tmpdir(), "lmgrep-profile-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function record(store, path, embeddingProfile = profile.data) {
	store.write(path, {
		root: "/project",
		branch: "main",
		model: oldName,
		dimensions: 2560,
		embeddingProfile,
	});
}

test("Docker aliases resolve by artifact, not their spelling", () => {
	const renamed = resolver.fromCatalog({ ...config, model: newName }, catalog);
	assert.ok(profile.equals(renamed.data));
	assert.equal(profile.toSlug(), renamed.toSlug());
	assert.ok(
		profile.equals(
			resolver.fromCatalog({ ...config, model: `docker:${digest}` }, catalog)
				.data,
		),
	);
});

test("different artifacts, dimensions and prefixes never share a verified index", () => {
	const different = resolver.fromCatalog(config, [
		{ id: otherDigest, tags: [oldName.slice(7)] },
	]);
	assert.notEqual(profile.toSlug(), different.toSlug());
	for (const settings of [
		{ dimensions: 1024 },
		{ queryPrefix: "query: " },
		{ documentPrefix: "document: " },
	]) {
		const changed = resolver.fromCatalog({ ...config, ...settings }, catalog);
		assert.equal(profile.equals(changed.data), false);
		assert.notEqual(profile.toSlug(), changed.toSlug());
	}
	assert.equal(
		profile.toSlug(),
		resolver
			.fromCatalog(
				{ ...config, queryPrefix: "", documentPrefix: "", batchSize: 99 },
				catalog,
			)
			.toSlug(),
	);
});

test("missing aliases, invalid digests and OpenAI catalogs are not evidence of identity", () => {
	assert.throws(
		() => resolver.fromCatalog(config, []),
		/not in the Docker model catalog/,
	);
	assert.throws(() =>
		resolver.fromCatalog(config, [{ id: "qwen3", tags: [oldName.slice(7)] }]),
	);
	assert.throws(() => resolver.fromCatalog(config, { data: catalog }));
});

test("verified sidecars reuse an index under an older directory name without rewriting it", (t) => {
	const root = temporary(t);
	const store = new ProjectMetadataStore();
	const previous = join(root, "older-layout");
	record(store, previous);
	const before = readFileSync(join(previous, "lmgrep.json"), "utf8");
	const renamed = resolver.fromCatalog({ ...config, model: newName }, catalog);
	assert.equal(new VerifiedIndexPath(renamed, store).resolve(root), previous);
	assert.equal(readFileSync(join(previous, "lmgrep.json"), "utf8"), before);
});

test("legacy metadata is preserved, never silently certified", (t) => {
	const root = temporary(t);
	const store = new ProjectMetadataStore();
	const previous = join(root, ModelIdentity.of(oldName).toSlug());
	store.write(previous, {
		root: "/project",
		branch: "main",
		model: oldName,
		dimensions: 2560,
	});
	const before = readFileSync(join(previous, "lmgrep.json"), "utf8");
	assert.equal(
		new VerifiedIndexPath(profile, store).resolve(root),
		join(root, profile.toSlug()),
	);
	assert.equal(readFileSync(join(previous, "lmgrep.json"), "utf8"), before);
	record(store, previous);
	assert.equal(store.read(previous).embeddingProfile, undefined);
});

test("metadata keeps the original verified profile and fills observed dimensions later", (t) => {
	const root = temporary(t);
	const store = new ProjectMetadataStore();
	store.write(root, {
		root,
		branch: "main",
		model: oldName,
		embeddingProfile: profile.data,
	});
	record(
		store,
		root,
		EmbeddingProfile.forArtifact(`docker:${otherDigest}`, config).data,
	);
	assert.ok(profile.equals(store.read(root).embeddingProfile));
	assert.equal(store.read(root).dimensions, 2560);
});

test("unknown or conflicting contents at a verified path are rejected", (t) => {
	const root = temporary(t);
	const path = join(root, profile.toSlug());
	mkdirSync(join(path, "chunks.lance"), { recursive: true });
	const store = new ProjectMetadataStore();
	assert.throws(
		() => new VerifiedIndexPath(profile, store).resolve(root),
		/Cannot verify/,
	);
	writeFileSync(
		join(path, "lmgrep.json"),
		JSON.stringify({
			embeddingProfile: { ...profile.data, queryPrefix: "wrong" },
		}),
	);
	assert.throws(
		() => new VerifiedIndexPath(profile, store).resolve(root),
		/Cannot verify/,
	);
});

test("ambiguous verified legacy locations require an explicit choice", (t) => {
	const root = temporary(t);
	const store = new ProjectMetadataStore();
	record(store, join(root, "one"));
	record(store, join(root, "two"));
	assert.throws(
		() => new VerifiedIndexPath(profile, store).resolve(root),
		/Multiple verified indexes/,
	);
	record(store, join(root, profile.toSlug()));
	assert.equal(
		new VerifiedIndexPath(profile, store).resolve(root),
		join(root, profile.toSlug()),
	);
});

test("project and named indexes use verified identity; explicit paths remain exact", (t) => {
	const root = temporary(t);
	const store = new ProjectMetadataStore();
	const state = new StateDirectory(join(root, "state"));
	const verified = new VerifiedIndexPath(profile, store);
	const locator = new ProjectLocator(
		new GitClient(),
		state,
		ModelIdentity.of(oldName),
		undefined,
		verified,
	);
	const renamed = new ProjectLocator(
		new GitClient(),
		state,
		ModelIdentity.of(newName),
		undefined,
		verified,
	);
	assert.equal(locator.databasePathFor(root), renamed.databasePathFor(root));
	assert.equal(
		locator.resolveDatabase(root, "named").path,
		renamed.resolveDatabase(root, "named").path,
	);
	assert.equal(
		locator.resolveDatabase(root, "./explicit").path,
		join(root, "explicit"),
	);
});
