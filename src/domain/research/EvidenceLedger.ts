import type { Hit } from "../retrieval/Hit.js";
import type { Source } from "./Citation.js";

/** One retained search hit, with its body clamped to a context budget. */
interface Evidence {
	n: number;
	path: string;
	startLine: number;
	endLine: number;
	text: string;
}

/**
 * Accumulates what the research loop has seen, and numbers it.
 *
 * Numbering is stable and deduplicated by location, so the same chunk surfaced
 * by two different searches keeps one id — otherwise the model would cite the
 * same code under several numbers and the source list would triple.
 */
export class EvidenceLedger {
	/**
	 * Cap on one hit's source. AST chunks are usually small; a large one is
	 * truncated to its head so a single search cannot swamp the context.
	 */
	private static readonly MAX_CONTENT_CHARS = 1400;

	/**
	 * Char budget for the digest fed to fallback synthesis. ~9k chars is
	 * roughly 2.5k tokens, which fits even an 8k window alongside the prompt
	 * and the answer.
	 */
	private static readonly DIGEST_CHAR_BUDGET = 9000;

	/** How many sources to offer when asking a model to add citations. */
	private static readonly MENU_SIZE = 12;

	private readonly sourceList: Source[] = [];
	private readonly byLocation = new Map<string, number>();
	private readonly evidence: Evidence[] = [];
	private readonly recorded = new Set<number>();

	get sources(): Source[] {
		return this.sourceList;
	}

	get isEmpty(): boolean {
		return this.evidence.length === 0;
	}

	/** Register hits, returning each one's id and the body shown to the model. */
	ingest(hits: readonly Hit[]): Array<{ id: number; hit: Hit; body: string }> {
		return hits.map((hit) => {
			const id = this.register(hit);
			const body = this.clamp(hit.content);
			if (!this.recorded.has(id)) {
				this.recorded.add(id);
				this.evidence.push({
					n: id,
					path: hit.location.filePath,
					startLine: hit.location.startLine,
					endLine: hit.location.endLine,
					text: body,
				});
			}
			return { id, hit, body };
		});
	}

	/**
	 * A budgeted digest of everything gathered, for one-shot synthesis in a
	 * fresh context. Blocks are truncated rather than dropped so the earliest
	 * (highest-ranked) evidence always appears.
	 */
	digest(): string {
		let budget = EvidenceLedger.DIGEST_CHAR_BUDGET;
		const blocks: string[] = [];

		for (const ev of this.evidence) {
			if (budget <= 0) break;
			const header = `[${ev.n}] ${ev.path}:${ev.startLine}-${ev.endLine}`;
			const overhead = header.length + 2;
			let text = ev.text;
			if (text.length + overhead > budget) {
				text = `${text.slice(0, Math.max(0, budget - overhead))}\n… (truncated)`;
			}
			blocks.push(`${header}\n${text}`);
			budget -= text.length + overhead;
		}
		return blocks.join("\n\n");
	}

	/** A compact source list, for asking a model to insert missing citations. */
	menu(): string {
		return this.evidence
			.slice(0, EvidenceLedger.MENU_SIZE)
			.map(
				(ev) =>
					`[${ev.n}] ${ev.path}:${ev.startLine}-${ev.endLine} — ${this.firstLine(ev.text)}`,
			)
			.join("\n");
	}

	private register(hit: Hit): number {
		const key = hit.location.toString();
		const existing = this.byLocation.get(key);
		if (existing != null) return existing;

		const n = this.sourceList.length + 1;
		this.sourceList.push({
			n,
			path: hit.location.filePath,
			startLine: hit.location.startLine,
			endLine: hit.location.endLine,
		});
		this.byLocation.set(key, n);
		return n;
	}

	private clamp(content: string): string {
		if (content.length <= EvidenceLedger.MAX_CONTENT_CHARS) return content;
		const head = content.slice(0, EvidenceLedger.MAX_CONTENT_CHARS);
		const omitted = content
			.slice(EvidenceLedger.MAX_CONTENT_CHARS)
			.split("\n").length;
		return `${head}\n… (${omitted} more lines — search a narrower query if you need them)`;
	}

	private firstLine(text: string): string {
		const line =
			text
				.split("\n")
				.find((l) => l.trim().length > 0)
				?.trim() ?? "";
		return line.length > 100 ? `${line.slice(0, 100)}…` : line;
	}
}
