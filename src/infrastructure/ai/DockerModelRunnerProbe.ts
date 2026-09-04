import type {
	CatalogedModel,
	DetectedRuntime,
	RuntimeProbe,
} from "./ModelRuntime.js";

/**
 * Detects Docker Model Runner through its OpenAI-compatible API.
 *
 * The model catalog does not expose capabilities, so embedding models are
 * inferred from well-known name fragments. Everything else remains untyped
 * and is only offered as a fallback embedding candidate.
 */
export class DockerModelRunnerProbe implements RuntimeProbe {
	static readonly BASE_URL = "http://localhost:12434/engines/v1";
	static readonly PROVIDER_PACKAGE = "@ai-sdk/openai-compatible";
	private static readonly TIMEOUT_MS = 3000;
	private static readonly EMBEDDING_HINTS = [
		"embed",
		"nomic",
		"bge",
		"minilm",
		"gte-",
		"e5-",
	];

	async detect(): Promise<DetectedRuntime | undefined> {
		let payload: { data?: Array<{ id: string }> };
		try {
			const response = await fetch(
				`${DockerModelRunnerProbe.BASE_URL}/models`,
				{
					signal: AbortSignal.timeout(DockerModelRunnerProbe.TIMEOUT_MS),
				},
			);
			if (!response.ok) return undefined;
			payload = (await response.json()) as {
				data?: Array<{ id: string }>;
			};
		} catch {
			return undefined;
		}

		const models: CatalogedModel[] = (payload.data ?? []).map((model) => ({
			id: model.id,
			kind: DockerModelRunnerProbe.looksLikeEmbedding(model.id)
				? "embedding"
				: "unknown",
		}));

		return {
			label: "Docker Model Runner",
			providerId: "docker",
			baseURL: DockerModelRunnerProbe.BASE_URL,
			providerPackage: DockerModelRunnerProbe.PROVIDER_PACKAGE,
			models,
		};
	}

	private static looksLikeEmbedding(name: string): boolean {
		const lower = name.toLowerCase();
		return DockerModelRunnerProbe.EMBEDDING_HINTS.some((hint) =>
			lower.includes(hint),
		);
	}
}
