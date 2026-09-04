import assert from "node:assert/strict";
import test from "node:test";

import { DockerModelRunnerProbe } from "../dist/infrastructure/ai/DockerModelRunnerProbe.js";

test("Docker Model Runner detection returns models through the bundled adapter", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		assert.equal(String(input), "http://localhost:12434/engines/v1/models");
		return new Response(
			JSON.stringify({
				data: [
					{ id: "docker.io/ai/text-embedding-qwen3-embedding-4b:q4_k_m" },
					{ id: "docker.io/google/gemma-4-e2b:q4_k_m" },
				],
			}),
			{ headers: { "content-type": "application/json" } },
		);
	};

	try {
		const runtime = await new DockerModelRunnerProbe().detect();

		assert.equal(runtime?.providerId, "docker");
		assert.equal(runtime?.providerPackage, "@ai-sdk/openai-compatible");
		assert.deepEqual(
			runtime?.models.map(({ kind }) => kind),
			["embedding", "unknown"],
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
