import type {
	CatalogedModel,
	DetectedRuntime,
	RuntimeProbe,
} from "./ModelRuntime.js";

/**
 * Detects a local Ollama server.
 *
 * Ollama's tag listing does not say what a model is for, so kind is inferred
 * from the name. That is a guess, and marked as one — `unknown` models are
 * offered only when nothing better is found.
 */
export class OllamaProbe implements RuntimeProbe {
	private static readonly TAGS_URL = "http://localhost:11434/api/tags";
	static readonly BASE_URL = "http://localhost:11434/v1";
	private static readonly TIMEOUT_MS = 3000;

	/** Name fragments that reliably indicate an embedding model. */
	private static readonly EMBEDDING_HINTS = [
		"embed",
		"nomic",
		"bge",
		"minilm",
		"gte-",
		"e5-",
	];

	async detect(): Promise<DetectedRuntime | undefined> {
		let payload: { models?: Array<{ name: string }> };
		try {
			const res = await fetch(OllamaProbe.TAGS_URL, {
				signal: AbortSignal.timeout(OllamaProbe.TIMEOUT_MS),
			});
			if (!res.ok) return undefined;
			payload = (await res.json()) as { models?: Array<{ name: string }> };
		} catch {
			return undefined;
		}

		const models: CatalogedModel[] = (payload.models ?? []).map((m) => ({
			id: m.name,
			kind: OllamaProbe.looksLikeEmbedding(m.name) ? "embedding" : "unknown",
		}));

		return {
			label: "Ollama",
			providerId: "ollama",
			baseURL: OllamaProbe.BASE_URL,
			models,
		};
	}

	private static looksLikeEmbedding(name: string): boolean {
		const lower = name.toLowerCase();
		return OllamaProbe.EMBEDDING_HINTS.some((hint) => lower.includes(hint));
	}
}
