import {
	createProviderRegistry,
	generateText,
	type LanguageModel,
	stepCountIs,
	tool,
} from "ai";
import { z } from "zod";
import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";
import type {
	ChatModelPort,
	ChatOutcome,
	CompletionRequest,
	ToolLoopRequest,
} from "../../domain/ports/ChatModelPort.js";
import { ProviderFailure } from "./ProviderFailure.js";
import { ModelReference, ProviderRegistry } from "./ProviderRegistry.js";

/**
 * The generative model behind `lmgrep ask`.
 *
 * It defaults to the embedding provider's package and baseURL, so enabling
 * `ask` on a local LM Studio or Ollama setup is a single config line rather
 * than a second provider block.
 */
export class AiSdkChatModel implements ChatModelPort {
	private model: LanguageModel | undefined;

	constructor(
		private readonly config: LmgrepConfig,
		private readonly providers: ProviderRegistry = new ProviderRegistry(),
	) {}

	/** Whether a chat model is configured at all — `ask` is hidden when not. */
	get isConfigured(): boolean {
		return Boolean(this.modelString);
	}

	/**
	 * Run the agentic loop, translating provider failures into outcomes.
	 *
	 * A timeout or an overflowed context is reported as `interrupted` rather
	 * than thrown: the caller still holds usable evidence and can synthesize
	 * from it, which is the difference between a slow answer and no answer.
	 */
	async runToolLoop(request: ToolLoopRequest): Promise<ChatOutcome> {
		const model = await this.resolve();
		let steps = 0;

		const searchTool = tool({
			description: request.toolDescription,
			inputSchema: z.object({
				query: z
					.string()
					.describe("Natural-language intent, phrased as a question."),
				filePrefix: z
					.string()
					.optional()
					.describe("Restrict to files under this path prefix."),
				type: z
					.array(z.string())
					.optional()
					.describe("Filter by AST node type (e.g. ['function_declaration'])."),
				language: z
					.array(z.string())
					.optional()
					.describe("Filter by file extension (e.g. ['.ts'])."),
				limit: z.number().optional().describe("Max hits (default 5)."),
			}),
			execute: async (call) => request.onSearch(call),
		});

		try {
			const result = await generateText({
				model,
				system: request.system,
				prompt: request.prompt,
				tools: { search: searchTool },
				stopWhen: stepCountIs(request.maxSteps),
				temperature: 0,
				abortSignal: AbortSignal.timeout(request.timeoutMs),
				onStepFinish: () => {
					steps++;
				},
			});
			return { status: "completed", text: result.text.trim(), steps };
		} catch (err) {
			if (ProviderFailure.isAbort(err)) {
				return { status: "interrupted", reason: "timeout", steps };
			}
			if (ProviderFailure.isContextOverflow(err)) {
				return {
					status: "interrupted",
					reason: "context-overflow",
					steps,
				};
			}
			return { status: "failed", error: err, steps };
		}
	}

	async complete(request: CompletionRequest): Promise<string | undefined> {
		try {
			const result = await generateText({
				model: await this.resolve(),
				system: request.system,
				prompt: request.prompt,
				temperature: 0,
				abortSignal: AbortSignal.timeout(request.timeoutMs),
			});
			return result.text.trim() || undefined;
		} catch (err) {
			ProviderFailure.debug("completion", err);
			return undefined;
		}
	}

	private async resolve(): Promise<LanguageModel> {
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
