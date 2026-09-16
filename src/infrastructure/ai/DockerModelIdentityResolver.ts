import { z } from "zod";
import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";
import { EmbeddingProfile } from "../../domain/project/EmbeddingProfile.js";
import { DockerModelRunnerProbe } from "./DockerModelRunnerProbe.js";

const catalogSchema = z.array(
	z.object({
		id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		tags: z.array(z.string()).nullish(),
	}),
);

export class DockerModelIdentityResolver {
	async resolve(config: LmgrepConfig): Promise<EmbeddingProfile | undefined> {
		if (!config.model.startsWith("docker:")) return undefined;
		const model = config.model.slice("docker:".length);
		const baseURL = config.baseURL ?? DockerModelRunnerProbe.BASE_URL;
		const endpoint = new URL(baseURL);
		endpoint.pathname = `${endpoint.pathname.replace(/\/(?:engines(?:\/[^/]+)?)?\/?v1\/?$/, "").replace(/\/$/, "")}/models`;
		endpoint.search = "";
		endpoint.hash = "";
		try {
			const response = await fetch(endpoint, {
				signal: AbortSignal.timeout(3000),
			});
			if (!response.ok)
				throw new Error(`Model catalog returned HTTP ${response.status}`);
			return this.fromCatalog(config, await response.json());
		} catch (error) {
			throw new Error(
				`Cannot verify Docker model identity for "${model}" at ${endpoint}. ` +
					"Existing indexes were not changed. Ensure Docker Model Runner is reachable and the model is installed.",
				{ cause: error },
			);
		}
	}

	fromCatalog(config: LmgrepConfig, payload: unknown): EmbeddingProfile {
		const name = config.model.slice("docker:".length);
		const catalog = catalogSchema.parse(payload);
		const normalized = this.normalizeReference(name);
		const model = catalog.find(
			(entry) =>
				entry.id === name ||
				entry.tags?.some((tag) => this.normalizeReference(tag) === normalized),
		);
		if (!model)
			throw new Error(`Model "${name}" is not in the Docker model catalog`);
		return EmbeddingProfile.forArtifact(`docker:${model.id}`, config);
	}

	private normalizeReference(name: string): string {
		if (name.startsWith("sha256:")) return name;
		let reference = name;
		if (!reference.includes("/")) reference = `docker.io/library/${reference}`;
		else if (
			!/[.:]/.test(reference.split("/")[0]) &&
			!reference.startsWith("localhost/")
		)
			reference = `docker.io/${reference}`;
		if (!reference.slice(reference.lastIndexOf("/") + 1).includes(":"))
			reference += ":latest";
		return reference;
	}
}
