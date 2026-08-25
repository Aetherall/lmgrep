import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";
import type {
	ChatModelPort,
	SearchToolCall,
} from "../../domain/ports/ChatModelPort.js";
import {
	CitationMarkers,
	type Source,
} from "../../domain/research/Citation.js";
import { EvidenceLedger } from "../../domain/research/EvidenceLedger.js";
import {
	ResearchTrace,
	type TraceEntry,
} from "../../domain/research/ResearchTrace.js";
import type { HitList } from "../../domain/retrieval/HitList.js";
import {
	SearchCriteria,
	type SearchOptions,
} from "../search/SearchCriteria.js";
import { ResearchPrompts } from "./ResearchPrompts.js";

export interface ResearchResult {
	question: string;
	answer: string;
	/** Sources the answer actually cited, in citation order. */
	sources: Source[];
	trace: TraceEntry[];
	steps: number;
	elapsedMs: number;
	/**
	 * True when synthesis was unavailable and the result fell back to raw
	 * search hits, so the caller knows not to over-trust the answer.
	 */
	degraded: boolean;
}

/** How the agent reaches the index. */
export interface ResearchSearcher {
	search(query: string, criteria: SearchCriteria): Promise<HitList>;
}

/**
 * Answers a question by searching the codebase and synthesizing a cited answer.
 *
 * Robustness is layered, because a local model fails in several distinct ways
 * and none of them should hard-fail the caller:
 *
 *  1. Happy path — the model self-terminates with a cited answer.
 *  2. It cannot self-terminate (step cap, timeout, or the transcript overflows
 *     its context) — synthesize from a budgeted digest in a fresh context.
 *  3. It answered without ever searching — discard that, since it is ungrounded
 *     by construction, search directly and synthesize.
 *  4. The model is unreachable — degrade to raw search hits.
 */
export class ResearchAgent {
	private static readonly DEFAULT_MAX_STEPS = 8;
	/**
	 * Wall clock is only a backstop against a wedged run; the search and step
	 * budgets bound the real work. A local model doing a few steps plus a cold
	 * load can need minutes, so this stays generous.
	 */
	private static readonly DEFAULT_TIMEOUT_MS = 240_000;
	private static readonly MAX_SEARCHES = 8;
	private static readonly DEFAULT_SEARCH_LIMIT = 5;
	/** The model tends to ask for 10+, which bloats the transcript. */
	private static readonly MAX_SEARCH_LIMIT = 6;
	/** After this many searches, nudge it to wrap up. */
	private static readonly NUDGE_AFTER = 3;

	constructor(
		private readonly searcher: ResearchSearcher,
		private readonly chat: ChatModelPort,
		private readonly config: LmgrepConfig,
	) {}

	async research(
		question: string,
		onTrace?: (entry: TraceEntry) => void,
	): Promise<ResearchResult> {
		if (!this.chat.isConfigured) {
			throw new Error(
				"`lmgrep ask` requires a chat model. Set `chatModel` in your lmgrep config " +
					"(e.g. `chatModel: lmstudio:qwen/qwen3.5-9b`).",
			);
		}

		const started = Date.now();
		const trace = new ResearchTrace(onTrace);
		const ledger = new EvidenceLedger();
		const timeoutMs =
			this.config.chatTimeoutMs ?? ResearchAgent.DEFAULT_TIMEOUT_MS;
		const maxSteps =
			this.config.chatMaxSteps ?? ResearchAgent.DEFAULT_MAX_STEPS;

		let searchCount = 0;

		const runSearch = async (call: SearchToolCall): Promise<string> => {
			if (searchCount >= ResearchAgent.MAX_SEARCHES) {
				return ResearchPrompts.BUDGET_EXHAUSTED;
			}
			searchCount++;

			const hits = await this.runSearch(call.query, {
				limit: Math.min(
					call.limit ?? ResearchAgent.DEFAULT_SEARCH_LIMIT,
					ResearchAgent.MAX_SEARCH_LIMIT,
				),
				filePrefix: call.filePrefix,
				type: call.type,
				language: call.language,
			});
			trace.searched(call.query, hits.length);

			if (hits.isEmpty) {
				return `No results for "${call.query}". Try different wording or a broader query.`;
			}

			const blocks = ledger
				.ingest(hits.toArray())
				.map(
					({ id, hit, body }) =>
						`[${id}] ${hit.location} · ${hit.type} ${hit.name} · score ${hit.score.toFixed(2)}\n${body}`,
				);
			const parts = [`Results for "${call.query}":`, ...blocks];
			if (searchCount >= ResearchAgent.NUDGE_AFTER) {
				parts.push(ResearchPrompts.WRAP_UP);
			}
			return parts.join("\n\n");
		};

		const outcome = await this.chat.runToolLoop({
			system: ResearchPrompts.SYSTEM,
			prompt: question,
			maxSteps,
			timeoutMs,
			toolDescription: ResearchPrompts.SEARCH_TOOL,
			onSearch: runSearch,
		});

		const steps = outcome.steps;
		let answer = outcome.status === "completed" ? outcome.text : "";

		if (outcome.status === "failed") {
			return this.degrade(question, outcome.error, trace, steps, started);
		}
		if (outcome.status === "interrupted") {
			trace.noted(
				outcome.reason === "timeout"
					? `Timed out after ${timeoutMs}ms`
					: "Model context exceeded mid-loop — synthesizing from gathered evidence.",
			);
		}

		// The provider cannot be made to force a tool call (LM Studio ignores
		// toolChoice), so the model sometimes answers from prior knowledge. An
		// answer with no search behind it is ungrounded by construction —
		// discard it and ground the question directly.
		if (searchCount === 0) {
			trace.noted(
				"Model answered without searching — grounding from a direct search.",
			);
			try {
				const hits = await this.runSearch(question, {
					limit: ResearchAgent.DEFAULT_SEARCH_LIMIT,
				});
				trace.searched(question, hits.length);
				ledger.ingest(hits.toArray());
			} catch (err) {
				return this.degrade(question, err, trace, steps, started);
			}
			answer = "";
		}

		if (!answer) {
			answer =
				(await this.synthesize(question, ledger, trace, timeoutMs)) ?? "";
		}
		if (!answer) {
			return this.degrade(
				question,
				new Error("Model produced no answer."),
				trace,
				steps,
				started,
			);
		}

		// Small models drop [n] markers inconsistently on terse answers. One
		// cheap annotation pass beats returning an uncitable result.
		if (!CitationMarkers.present(answer) && !ledger.isEmpty) {
			answer = await this.addCitations(answer, ledger, trace, timeoutMs);
		}

		return {
			question,
			answer,
			sources: CitationMarkers.resolve(answer, ledger.sources),
			trace: trace.toArray(),
			steps,
			elapsedMs: Date.now() - started,
			degraded: false,
		};
	}

	private runSearch(query: string, options: SearchOptions): Promise<HitList> {
		return this.searcher.search(query, new SearchCriteria(options));
	}

	/**
	 * One-shot synthesis over a budgeted digest, in a fresh context with no
	 * tool transcript to replay — which is what makes it work even when the
	 * agentic loop overflowed the window.
	 */
	private async synthesize(
		question: string,
		ledger: EvidenceLedger,
		trace: ResearchTrace,
		timeoutMs: number,
	): Promise<string | undefined> {
		if (ledger.isEmpty) return undefined;
		trace.noted("Synthesizing answer from evidence…");
		return this.chat.complete({
			system: ResearchPrompts.SYSTEM,
			prompt:
				`Question: ${question}\n\nEvidence gathered from the codebase:\n\n` +
				`${ledger.digest()}\n\n${ResearchPrompts.FORCE_ANSWER}`,
			timeoutMs,
		});
	}

	/** Ask the model to insert markers into its own answer, wording unchanged. */
	private async addCitations(
		answer: string,
		ledger: EvidenceLedger,
		trace: ResearchTrace,
		timeoutMs: number,
	): Promise<string> {
		trace.noted("Answer had no citations — adding them.");
		const revised = await this.chat.complete({
			system: ResearchPrompts.ADD_CITATIONS,
			prompt: `Sources:\n${ledger.menu()}\n\nAnswer to annotate:\n${answer}`,
			timeoutMs,
		});
		// Keep the original if the retry failed or still has no markers.
		return revised && CitationMarkers.present(revised) ? revised : answer;
	}

	/** Last resort: return the raw hits, clearly marked as un-synthesized. */
	private async degrade(
		question: string,
		error: unknown,
		trace: ResearchTrace,
		steps: number,
		started: number,
	): Promise<ResearchResult> {
		const message = error instanceof Error ? error.message : String(error);
		trace.noted(`Synthesis unavailable: ${message}`);

		let sources: Source[] = [];
		let body: string;
		try {
			const hits = await this.runSearch(question, {
				limit: ResearchAgent.DEFAULT_SEARCH_LIMIT,
			});
			const list = hits.toArray();
			sources = list.map((hit, i) => ({
				n: i + 1,
				path: hit.location.filePath,
				startLine: hit.location.startLine,
				endLine: hit.location.endLine,
			}));
			body = list.length
				? list
						.map(
							(hit, i) =>
								`[${i + 1}] ${hit.location} (${hit.type} ${hit.name})`,
						)
						.join("\n")
				: "No results found.";
		} catch {
			body = "No results found (search also failed).";
		}

		return {
			question,
			answer: `Synthesis unavailable (${message}). Raw search results:\n${body}`,
			sources,
			trace: trace.toArray(),
			steps,
			elapsedMs: Date.now() - started,
			degraded: true,
		};
	}
}
