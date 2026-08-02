import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { LmgrepIndex } from "../index.js";
import { AISDKGenerator } from "./generator.js";

/** Defaults for the agentic loop — overridable via config. */
const DEFAULT_MAX_STEPS = 8;
// Wall-clock is only a backstop against a wedged run — the search/step budgets
// are what actually bound the work. A local model doing a few search→answer
// steps (plus a possible cold model load) can need a couple of minutes, so keep
// this generous.
const DEFAULT_TIMEOUT_MS = 240_000;
const MAX_SEARCHES = 8;
const DEFAULT_SEARCH_LIMIT = 5;
// Hard ceiling on hits per search — the model tends to ask for 10+, which bloats
// the transcript and tempts it to keep chasing leads instead of answering.
const MAX_SEARCH_LIMIT = 6;
// After this many searches, nudge the model to wrap up rather than keep exploring.
const SEARCH_NUDGE_AFTER = 3;
// Cap each hit's source so one search stays within a modest context window.
// AST chunks are usually small; large ones are truncated to their head.
const MAX_CONTENT_CHARS = 1400;
// Char budget for the evidence digest fed to the fallback synthesis. ~9k chars
// ≈ 2.5k tokens — fits even a modest (8k) context alongside prompt + answer.
const EVIDENCE_CHAR_BUDGET = 9000;

export interface Source {
	n: number;
	path: string;
	startLine: number;
	endLine: number;
}

export type TraceEntry =
	| { kind: "search"; query: string; hits: number }
	| { kind: "note"; message: string };

export interface ResearchResult {
	question: string;
	answer: string;
	/** Sources the answer actually cited, in citation order. */
	sources: Source[];
	trace: TraceEntry[];
	steps: number;
	elapsedMs: number;
	/**
	 * True when synthesis was unavailable (model unreachable/errored) and we fell
	 * back to raw search hits, so the caller knows not to over-trust the answer.
	 */
	degraded: boolean;
}

export interface ResearchOptions {
	index: LmgrepIndex;
	cwd: string;
	question: string;
	/** Live progress callback (each search/note as it happens). */
	onTrace?: (entry: TraceEntry) => void;
}

/** Captured search hit, used to synthesize an answer if the loop can't self-terminate. */
interface Evidence {
	n: number;
	path: string;
	startLine: number;
	endLine: number;
	text: string;
}

const SYSTEM_PROMPT = [
	"You are a code research assistant working inside a repository. Answer the user's question by searching the codebase and writing a concise, grounded answer.",
	"",
	"Tool:",
	"- search({query, filePrefix?, type?, language?, limit?}): semantic code search. Returns the top matching code units (functions, classes, blocks), each with a [n] id, its file:line, and its source. Phrase `query` as a natural-language intent, not keywords. The returned source is what you answer from — there is no separate file-reading step.",
	"",
	"Method — be decisive, minimize steps (each step is slow):",
	"- ALWAYS search before answering. Never answer from prior knowledge or assumptions — the codebase is the only source of truth, and defaults, names, and behavior often differ from what you'd guess.",
	"- A grounded, focused answer beats an exhaustive survey. Aim to answer in as few searches as possible.",
	"- Typical shape: one search → answer. Search again ONLY if the results revealed a specific gap, or surfaced codebase vocabulary you should follow up on with a sharper query.",
	"- Never search for completeness, breadth, or to double-check. The moment the results let you answer, STOP searching and write the answer.",
	"",
	"Answer rules:",
	"- Cite with the [n] id, never a bare file path. Every claim needs a [n]. Example: write \"changes are debounced for 2s [2]\", not \"in scanner.ts, changes are debounced\".",
	"- Do NOT paste code blocks or quote source verbatim. Describe what the code does in your own words and cite [n].",
	"- Be tight: what the code does, where, and how. No tours, no restating the question.",
	"- If the results do not answer the question, say so plainly and list what's missing. Never invent file paths, line numbers, or behavior.",
].join("\n");

const FORCE_ANSWER_PROMPT =
	"Using ONLY the evidence above, write the final answer now. Cite [n] for every claim, reusing the ids shown. If the evidence is insufficient, say so plainly and list what is still missing. Do not ask to search further.";

/**
 * Run the agentic research loop: a local chat model drives a single `search`
 * tool (which returns matching source) against the index, then writes a
 * grounded, cited answer.
 *
 * Robustness is layered so it never hard-fails the caller:
 * 1. Happy path — the model self-terminates and emits a cited answer.
 * 2. Can't self-terminate (step cap, timeout, or the transcript overflows the
 *    model's context) — synthesize from a budgeted digest of the search hits
 *    already gathered, in a fresh small context.
 * 3. Model unreachable / no evidence — degrade to raw search hits.
 */
export async function research(opts: ResearchOptions): Promise<ResearchResult> {
	const { index, question, onTrace } = opts;
	const config = index.config;
	const started = Date.now();

	const generator = new AISDKGenerator(config);
	if (!generator.hasModel()) {
		throw new Error(
			"`lmgrep ask` requires a chat model. Set `chatModel` in your lmgrep config " +
				'(e.g. `chatModel: lmstudio:qwen/qwen3.5-9b`).',
		);
	}

	const maxSteps = config.chatMaxSteps ?? DEFAULT_MAX_STEPS;
	const timeoutMs = config.chatTimeoutMs ?? DEFAULT_TIMEOUT_MS;

	// --- Shared session state (closed over by the tool) ---
	const sources: Source[] = [];
	const sourceIndex = new Map<string, number>();
	const evidence: Evidence[] = [];
	const seenEvidence = new Set<number>();
	const trace: TraceEntry[] = [];
	let searchCount = 0;

	function record(entry: TraceEntry): void {
		trace.push(entry);
		onTrace?.(entry);
	}

	function registerSource(
		path: string,
		startLine: number,
		endLine: number,
	): number {
		const key = `${path}:${startLine}-${endLine}`;
		const existing = sourceIndex.get(key);
		if (existing != null) return existing;
		const n = sources.length + 1;
		sources.push({ n, path, startLine, endLine });
		sourceIndex.set(key, n);
		return n;
	}

	/** Register a result set as sources + evidence; returns each hit's id and clamped body. */
	function ingest(
		results: Awaited<ReturnType<LmgrepIndex["search"]>>,
	): Array<{ id: number; r: (typeof results)[number]; body: string }> {
		return results.map((r) => {
			const id = registerSource(r.filePath, r.startLine, r.endLine);
			const body = clampContent(r.content);
			if (!seenEvidence.has(id)) {
				seenEvidence.add(id);
				evidence.push({
					n: id,
					path: r.filePath,
					startLine: r.startLine,
					endLine: r.endLine,
					text: body,
				});
			}
			return { id, r, body };
		});
	}

	const searchTool = tool({
		description:
			"Semantic code search. Returns the top matching code units, each with a [n] id, file:line, and its source. This is the only tool — answer from what it returns.",
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
		execute: async ({ query, filePrefix, type, language, limit }) => {
			if (searchCount >= MAX_SEARCHES) {
				return "Search budget exhausted. Stop searching and answer from what you have.";
			}
			searchCount++;
			const results = await index.search(query, {
				limit: Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
				filePrefix,
				type,
				language,
			});
			record({ kind: "search", query, hits: results.length });
			if (results.length === 0) {
				return `No results for "${query}". Try different wording or a broader query.`;
			}
			const blocks = ingest(results).map(
				({ id, r, body }) =>
					`[${id}] ${r.filePath}:${r.startLine}-${r.endLine} · ${r.type} ${r.name} · score ${r.score.toFixed(2)}\n${body}`,
			);
			const parts = [`Results for "${query}":`, ...blocks];
			if (searchCount >= SEARCH_NUDGE_AFTER) {
				parts.push(
					"(You've searched several times — answer now from what you've gathered unless a specific detail is still missing.)",
				);
			}
			return parts.join("\n\n");
		},
	});

	const model = await generator.getModel();

	let finalText = "";
	let stepCount = 0;

	try {
		const result = await generateText({
			model,
			system: SYSTEM_PROMPT,
			prompt: question,
			tools: { search: searchTool },
			stopWhen: stepCountIs(maxSteps),
			temperature: 0,
			abortSignal: AbortSignal.timeout(timeoutMs),
			onStepFinish: () => {
				stepCount++;
			},
		});
		finalText = result.text.trim();
	} catch (err) {
		if (isAbort(err)) {
			record({ kind: "note", message: `Timed out after ${timeoutMs}ms` });
		} else if (isContextOverflow(err)) {
			record({
				kind: "note",
				message:
					"Model context exceeded mid-loop — synthesizing from gathered evidence.",
			});
		} else {
			return degradeToRawSearch(err);
		}
	}

	// Grounding guarantee: the provider can't force a tool call (LM Studio
	// ignores toolChoice), so the model sometimes answers from prior knowledge
	// without searching. If it never searched, its answer is ungrounded —
	// discard it, search the question directly, and synthesize from real hits.
	if (searchCount === 0) {
		record({
			kind: "note",
			message: "Model answered without searching — grounding from a direct search.",
		});
		try {
			const results = await index.search(question, {
				limit: DEFAULT_SEARCH_LIMIT,
			});
			record({ kind: "search", query: question, hits: results.length });
			ingest(results);
		} catch (err) {
			return degradeToRawSearch(err);
		}
		finalText = "";
	}

	// The loop didn't self-terminate (step cap, timeout, or context overflow),
	// or we just discarded an ungrounded answer. Synthesize from the hits we
	// captured, in a fresh, budgeted context.
	if (!finalText) {
		finalText = (await synthesizeFromEvidence()) ?? "";
	}

	if (!finalText) {
		return degradeToRawSearch(new Error("Model produced no answer."));
	}

	// Small models drop the [n] citations inconsistently, especially on terse
	// one-shot answers. If none are present, annotate the answer in one cheap
	// pass rather than returning an ungrounded result.
	if (!hasCitation(finalText) && evidence.length > 0) {
		finalText = await ensureCitations(finalText);
	}

	return {
		question,
		answer: finalText,
		sources: resolveCitations(finalText, sources),
		trace,
		steps: stepCount,
		elapsedMs: Date.now() - started,
		degraded: false,
	};

	// --- synthesis fallback ---

	/**
	 * Single-shot synthesis over a budgeted digest of what `search` surfaced. Uses
	 * a fresh context (no tool-call transcript to replay), so it works even when
	 * the agentic loop overflowed the model's window. Returns null if there's
	 * nothing to synthesize from or the model still can't answer.
	 */
	async function synthesizeFromEvidence(): Promise<string | null> {
		if (evidence.length === 0) return null;
		let budget = EVIDENCE_CHAR_BUDGET;
		const blocks: string[] = [];
		for (const ev of evidence) {
			if (budget <= 0) break;
			const header = `[${ev.n}] ${ev.path}:${ev.startLine}-${ev.endLine}`;
			let text = ev.text;
			const overhead = header.length + 2;
			if (text.length + overhead > budget) {
				text = `${text.slice(0, Math.max(0, budget - overhead))}\n… (truncated)`;
			}
			blocks.push(`${header}\n${text}`);
			budget -= text.length + overhead;
		}
		const digest = blocks.join("\n\n");
		record({ kind: "note", message: "Synthesizing answer from evidence…" });
		try {
			const forced = await generateText({
				model,
				system: SYSTEM_PROMPT,
				prompt: `Question: ${question}\n\nEvidence gathered from the codebase:\n\n${digest}\n\n${FORCE_ANSWER_PROMPT}`,
				temperature: 0,
				abortSignal: AbortSignal.timeout(timeoutMs),
			});
			return forced.text.trim() || null;
		} catch (err) {
			debugError("evidence synthesis", err);
			return null;
		}
	}

	/**
	 * The model answered without any [n] markers. Give it a compact menu of the
	 * sources it saw and ask it to insert citations into its own answer, without
	 * changing the wording. Returns the original answer if the retry fails or
	 * still produces no citations.
	 */
	async function ensureCitations(answer: string): Promise<string> {
		const menu = evidence
			.slice(0, 12)
			.map(
				(ev) =>
					`[${ev.n}] ${ev.path}:${ev.startLine}-${ev.endLine} — ${firstLine(ev.text)}`,
			)
			.join("\n");
		record({ kind: "note", message: "Answer had no citations — adding them." });
		try {
			const r = await generateText({
				model,
				temperature: 0,
				abortSignal: AbortSignal.timeout(timeoutMs),
				system:
					"You add source citations to an existing answer. Insert [n] markers after the claims each source supports, using the ids from the source list. Do not change the wording or substance otherwise. Output only the revised answer.",
				prompt: `Sources:\n${menu}\n\nAnswer to annotate:\n${answer}`,
			});
			const revised = r.text.trim();
			return hasCitation(revised) ? revised : answer;
		} catch (err) {
			debugError("citation retry", err);
			return answer;
		}
	}

	async function degradeToRawSearch(err: unknown): Promise<ResearchResult> {
		debugError("research", err);
		const msg = err instanceof Error ? err.message : String(err);
		record({ kind: "note", message: `Synthesis unavailable: ${msg}` });
		let hits: Source[] = [];
		let body = "";
		try {
			const results = await index.search(question, {
				limit: DEFAULT_SEARCH_LIMIT,
			});
			hits = results.map((r, i) => ({
				n: i + 1,
				path: r.filePath,
				startLine: r.startLine,
				endLine: r.endLine,
			}));
			body = results.length
				? results
						.map(
							(r, i) =>
								`[${i + 1}] ${r.filePath}:${r.startLine}-${r.endLine} (${r.type} ${r.name})`,
						)
						.join("\n")
				: "No results found.";
		} catch {
			body = "No results found (search also failed).";
		}
		return {
			question,
			answer: `Synthesis unavailable (${msg}). Raw search results:\n${body}`,
			sources: hits,
			trace,
			steps: stepCount,
			elapsedMs: Date.now() - started,
			degraded: true,
		};
	}
}

// Citation markers as models actually emit them: a single `[3]`, and the
// grouped `[3, 5]` form small models reach for when one claim has several
// sources. Both must parse — a marker we can't read is a source silently
// missing from the answer's `Sources:` list, which is exactly the grounding
// the answer is supposed to provide.
const CITATION_RE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** Every cited id, in first-appearance order, groups expanded. May repeat. */
function citedIds(text: string): number[] {
	const out: number[] = [];
	for (const m of text.matchAll(CITATION_RE)) {
		for (const part of m[1].split(",")) out.push(Number(part.trim()));
	}
	return out;
}

/** Whether the text contains at least one `[n]` citation marker. */
function hasCitation(text: string): boolean {
	return citedIds(text).length > 0;
}

/** First non-empty line of a chunk's source, trimmed and capped, for a source menu. */
function firstLine(text: string): string {
	const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
	return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

/** Cap a chunk's source so one search stays within a modest context window. */
function clampContent(content: string): string {
	if (content.length <= MAX_CONTENT_CHARS) return content;
	const head = content.slice(0, MAX_CONTENT_CHARS);
	const omitted = content.slice(MAX_CONTENT_CHARS).split("\n").length;
	return `${head}\n… (${omitted} more lines — search a narrower query if you need them)`;
}

function debugError(where: string, err: unknown): void {
	if (!process.env.LMGREP_DEBUG) return;
	const e = err as Record<string, unknown>;
	console.error(`[lmgrep debug] ${where} error:`, {
		name: e?.name,
		message: e?.message,
		statusCode: e?.statusCode,
		responseBody: e?.responseBody,
	});
}

function isAbort(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.name === "AbortError" || err.name === "TimeoutError")
	);
}

/** A provider 400 whose body mentions the context/window being exceeded. */
function isContextOverflow(err: unknown): boolean {
	const e = err as {
		statusCode?: number;
		responseBody?: string;
		message?: string;
	};
	if (e?.statusCode !== 400) return false;
	const body = `${e.responseBody ?? ""} ${e.message ?? ""}`;
	return /context (size|length|window)|exceed|too (long|large)|max.*token/i.test(
		body,
	);
}

/**
 * Extract cited [n] ids in first-appearance order and resolve them against the
 * sources actually surfaced. Hallucinated ids (not in the source set) are
 * dropped — the answer text keeps the marker, but no bogus source is listed.
 */
function resolveCitations(answer: string, sources: Source[]): Source[] {
	const byN = new Map(sources.map((s) => [s.n, s]));
	const seen = new Set<number>();
	const out: Source[] = [];
	for (const n of citedIds(answer)) {
		if (seen.has(n)) continue;
		seen.add(n);
		const src = byN.get(n);
		if (src) out.push(src);
	}
	return out;
}
