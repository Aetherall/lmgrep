import type {
	CatalogedModel,
	DetectedRuntime,
	ModelKind,
	RuntimeProbe,
} from "./ModelRuntime.js";

/**
 * Detects a local LM Studio server.
 *
 * LM Studio's native listing reports each model's type, so kinds come from the
 * server rather than from guessing at names. Its OpenAI-compatible `/v1`
 * surface is what the embedding calls actually use.
 */
export class LmStudioProbe implements RuntimeProbe {
	private static readonly CATALOG_URL = "http://localhost:1234/api/v0/models";
	static readonly BASE_URL = "http://localhost:1234/v1";
	/** LM Studio speaks OpenAI's protocol, not one of its own. */
	static readonly PROVIDER_PACKAGE = "@ai-sdk/openai-compatible";
	private static readonly TIMEOUT_MS = 3000;

	async detect(): Promise<DetectedRuntime | undefined> {
		let payload: { data?: Array<{ id: string; type?: string }> };
		try {
			const res = await fetch(LmStudioProbe.CATALOG_URL, {
				signal: AbortSignal.timeout(LmStudioProbe.TIMEOUT_MS),
			});
			if (!res.ok) return undefined;
			payload = (await res.json()) as {
				data?: Array<{ id: string; type?: string }>;
			};
		} catch {
			return undefined;
		}

		const models: CatalogedModel[] = (payload.data ?? []).map((m) => ({
			id: m.id,
			kind: LmStudioProbe.kindOf(m.type),
		}));

		return {
			label: "LM Studio",
			providerId: "lmstudio",
			baseURL: LmStudioProbe.BASE_URL,
			providerPackage: LmStudioProbe.PROVIDER_PACKAGE,
			models,
		};
	}

	/** `vlm` is a vision-capable chat model, and answers text prompts fine. */
	private static kindOf(type: string | undefined): ModelKind {
		if (type === "embeddings") return "embedding";
		if (type === "llm" || type === "vlm") return "chat";
		return "unknown";
	}
}
