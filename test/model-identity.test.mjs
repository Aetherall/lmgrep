import assert from "node:assert/strict";
import test from "node:test";

import { ModelIdentity } from "../dist/domain/project/ModelIdentity.js";

test("Docker Model Runner aliases reuse an existing model index", () => {
	const existing = ModelIdentity.of(
		"lmstudio:text-embedding-qwen3-embedding-4b",
	);
	const docker = ModelIdentity.of(
		"docker:docker.io/ai/text-embedding-qwen3-embedding-4b:q4_k_m",
	);

	assert.equal(docker.family, existing.family);
	assert.equal(docker.isSameFamilyAs(existing), true);
	assert.equal(docker.toSlug(), existing.toSlug());
});

test("different embedding dimensions remain separate indexes", () => {
	const model = ModelIdentity.of(
		"docker:huggingface.co/nomic-ai/nomic-embed-text",
	);

	assert.notEqual(model.toSlug(768), model.toSlug(1024));
});
