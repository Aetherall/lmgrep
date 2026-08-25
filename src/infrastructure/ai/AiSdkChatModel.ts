import { createProviderRegistry, type LanguageModel } from "ai";
import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";
import { ModelReference, ProviderRegistry } from "./ProviderRegistry.js";

/**
 * The generative model behind `lmgrep ask`.
 *
 * It defaults to the embedding provider's package and baseURL, so enabling
 * `ask` on a local LM Studio or Ollama setup is a single config line rather
 * than a second provider block.
 */
export class AiSdkChatModel {
	private model: LanguageModel | undefined;

	constructor(
		private readonly config: LmgrepConfig,
		private readonly providers: ProviderRegistry = new ProviderRegistry(),
	) {}

	/** Whether a chat model is configured at all — `ask` is hidden when not. */
	get isConfigured(): boolean {
		return Boolean(this.modelString);
	}

	async resolve(): Promise<LanguageModel> {
		if (this.model) return this.model;

		const modelString = this.modelString;
		if (!modelString) {
			throw new Error(
				"No chat model configured. Set `chatModel` in your lmgrep config " +
					"(e.g. `chatModel: lmstudio:qwen/qwen3.5-9b`) to use `lmgrep ask`.",
			);
		}

		const reference = ModelReference.parse(modelString, "chatModel");
		const instance = await this.providers.instantiate({
			reference,
			// Reuse the embedding provider package unless overridden — on a
			// shared local endpoint chat and embeddings sit behind one
			// OpenAI-compatible provider.
			packageName: this.config.chatProvider ?? this.config.provider,
			baseURL: this.baseURL,
			// A bare default export ignores baseURL and would hit the cloud, so
			// prefer the factory whenever one is configured.
			preferFactoryWhenBaseUrlSet: true,
		});

		const registry = createProviderRegistry({
			[reference.provider]: instance,
		} as Record<string, never>);

		this.model = registry.languageModel(
			reference.full as `${string}:${string}`,
		) as LanguageModel;
		return this.model;
	}

	/** Env overrides exist so several models can be benchmarked without edits. */
	private get modelString(): string | undefined {
		return process.env.LMGREP_CHAT_MODEL ?? this.config.chatModel;
	}

	private get baseURL(): string | undefined {
		return (
			process.env.LMGREP_CHAT_BASEURL ??
			this.config.chatBaseURL ??
			this.config.baseURL
		);
	}
}
