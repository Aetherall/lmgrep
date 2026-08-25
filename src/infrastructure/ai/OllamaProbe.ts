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
	/** Models currently resident in memory. */
	private static readonly RUNNING_URL = "http://localhost:11434/api/ps";
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

		const loaded = await this.loadedModelNames();
		const models: CatalogedModel[] = (payload.models ?? []).map((m) => ({
			id: m.name,
			kind: OllamaProbe.looksLikeEmbedding(m.name) ? "embedding" : "unknown",
			loaded: loaded.has(m.name),
		}));

		return {
			label: "Ollama",
			providerId: "ollama",
			baseURL: OllamaProbe.BASE_URL,
			models,
		};
	}

	/** Best-effort; an older Ollama without this endpoint just reports none. */
	private async loadedModelNames(): Promise<Set<string>> {
		try {
			const res = await fetch(OllamaProbe.RUNNING_URL, {
				signal: AbortSignal.timeout(OllamaProbe.TIMEOUT_MS),
			});
			if (!res.ok) return new Set();
			const payload = (await res.json()) as {
				models?: Array<{ name: string }>;
			};
			return new Set((payload.models ?? []).map((m) => m.name));
		} catch {
			return new Set();
		}
	}

	private static looksLikeEmbedding(name: string): boolean {
		const lower = name.toLowerCase();
		return OllamaProbe.EMBEDDING_HINTS.some((hint) => lower.includes(hint));
	}
}
