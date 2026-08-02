import { createProviderRegistry, type LanguageModel } from "ai";
import { importProvider } from "./providers.js";
import type { LmgrepConfig } from "./types.js";

/**
 * Loads the generative chat model used by `lmgrep ask`, mirroring
 * {@link AISDKEmbedder} but resolving a language model instead of an embedding
 * model. By default it reuses the embedding provider package and baseURL, so
 * enabling `ask` on a local LM Studio / Ollama setup is just one extra config
 * line (`chatModel: <provider>:<model>`).
 */
export class AISDKGenerator {
	private cached: LanguageModel | undefined;

	constructor(private config: LmgrepConfig) {}

	/** Whether a chat model is configured at all. */
	hasModel(): boolean {
		return !!(process.env.LMGREP_CHAT_MODEL ?? this.config.chatModel);
	}

	async getModel(): Promise<LanguageModel> {
		if (this.cached) return this.cached;

		// LMGREP_CHAT_MODEL / LMGREP_CHAT_BASEURL override config — handy for
		// benchmarking several models without editing the config file.
		const modelStr = process.env.LMGREP_CHAT_MODEL ?? this.config.chatModel;
		if (!modelStr) {
			throw new Error(
				"No chat model configured. Set `chatModel` in your lmgrep config " +
					'(e.g. `chatModel: lmstudio:qwen/qwen3.5-9b`) to use `lmgrep ask`.',
			);
		}

		const colonIdx = modelStr.indexOf(":");
		if (colonIdx === -1) {
			throw new Error(
				`chatModel must be in "provider:model" format. Got: "${modelStr}"`,
			);
		}

		const providerName = modelStr.slice(0, colonIdx);
		// Reuse the embedding provider package unless explicitly overridden — on a
		// shared local endpoint (LM Studio/Ollama) chat and embeddings live behind
		// the same OpenAI-compatible provider.
		const pkg =
			this.config.chatProvider ??
			this.config.provider ??
			`@ai-sdk/${providerName}`;
		const providerModule = await importProvider(pkg);
		const baseURL =
			process.env.LMGREP_CHAT_BASEURL ??
			this.config.chatBaseURL ??
			this.config.baseURL;

		let providerInstance = providerModule[providerName];

		// Prefer the factory when a baseURL is set so it actually applies — a bare
		// default export (e.g. `openai`) ignores baseURL and would hit the cloud.
		if (!providerInstance || baseURL) {
			const factoryKey = Object.keys(providerModule).find((k) =>
				k.startsWith("create"),
			);
			if (factoryKey) {
				const factory = providerModule[factoryKey] as (
					opts: Record<string, unknown>,
				) => unknown;
				providerInstance = factory({
					name: providerName,
					...(baseURL ? { baseURL } : {}),
				});
			}
		}

		if (!providerInstance) {
			throw new Error(
				`Package "${pkg}" has no usable provider export. Available: ${Object.keys(providerModule).join(", ")}`,
			);
		}

		const registry = createProviderRegistry({
			[providerName]: providerInstance,
		} as Record<string, never>);

		this.cached = registry.languageModel(
			modelStr as `${string}:${string}`,
		) as LanguageModel;
		return this.cached;
	}
}
