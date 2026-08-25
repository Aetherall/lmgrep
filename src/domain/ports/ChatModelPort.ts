/** A search the model asked for during a research loop. */
export interface SearchToolCall {
	query: string;
	filePrefix?: string;
	type?: string[];
	language?: string[];
	limit?: number;
}

/**
 * How a model run ended.
 *
 * `interrupted` is separated from `failed` on purpose: a step cap, a timeout,
 * or an overflowed context all leave the evidence gathered so far intact and
 * worth synthesizing from, whereas a failure means the model is unreachable.
 */
export type ChatOutcome =
	| { status: "completed"; text: string; steps: number }
	| {
			status: "interrupted";
			reason: "timeout" | "context-overflow";
			steps: number;
	  }
	| { status: "failed"; error: unknown; steps: number };

export interface ToolLoopRequest {
	system: string;
	prompt: string;
	maxSteps: number;
	timeoutMs: number;
	/** Describes the search tool to the model. */
	toolDescription: string;
	/** Runs a search the model requested, returning the text it should see. */
	onSearch: (call: SearchToolCall) => Promise<string>;
}

export interface CompletionRequest {
	system: string;
	prompt: string;
	timeoutMs: number;
}

/**
 * A generative model that can drive a search tool.
 *
 * Deliberately narrow: research needs exactly one agentic loop and one
 * single-shot completion, and keeping the port that small is what stops the
 * provider SDK leaking into the use case.
 */
export interface ChatModelPort {
	/** Whether a model is configured at all — `ask` is hidden when not. */
	readonly isConfigured: boolean;
	runToolLoop(request: ToolLoopRequest): Promise<ChatOutcome>;
	/** One-shot completion; undefined when the model produced nothing. */
	complete(request: CompletionRequest): Promise<string | undefined>;
}
