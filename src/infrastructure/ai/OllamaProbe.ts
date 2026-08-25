/**
 * Detects a local Ollama server and what it has pulled.
 *
 * `lmgrep init` uses this to configure itself without asking questions, which
 * is the difference between a working setup and a config file the user has to
 * research. Failure is silent and simply means "not running".
 */
export class OllamaProbe {
	private static readonly TAGS_URL = "http://localhost:11434/api/tags";
	static readonly BASE_URL = "http://localhost:11434/v1";
	private static readonly TIMEOUT_MS = 3000;

	/** Model names that suggest an embedding model rather than a chat one. */
	private static readonly EMBEDDING_HINTS = ["embed", "nomic", "bge", "minilm"];

	async detect(): Promise<{ running: boolean; models: string[] }> {
		try {
			const res = await fetch(OllamaProbe.TAGS_URL, {
				signal: AbortSignal.timeout(OllamaProbe.TIMEOUT_MS),
			});
			if (!res.ok) return { running: true, models: [] };
			const data = (await res.json()) as {
				models?: Array<{ name: string }>;
			};
			return {
				running: true,
				models: (data.models ?? []).map((m) => m.name),
			};
		} catch {
			return { running: false, models: [] };
		}
	}

	/** Prefer a model that looks like an embedder over an arbitrary first one. */
	static pickEmbeddingModel(models: string[]): string | undefined {
		if (models.length === 0) return undefined;
		return (
			models.find((m) =>
				OllamaProbe.EMBEDDING_HINTS.some((hint) => m.includes(hint)),
			) ?? models[0]
		);
	}
}
