import type { FacetView } from "../../application/faceting/FacetNavigator.js";
import type { ResearchResult } from "../../application/research/ResearchAgent.js";
import type { Hit } from "../../domain/retrieval/Hit.js";

/**
 * Renders results as the plain text an MCP client receives.
 *
 * Format is chosen for an agent reader, not a human one: location and context
 * come first so a hit can be acted on without a follow-up file read, which is
 * the whole point of returning the source inline.
 */
export class HitFormatter {
	static hits(hits: readonly Hit[]): string {
		return hits
			.map((hit) => {
				const header =
					`${hit.location} [${hit.type}] ${hit.name} ` +
					`(score: ${hit.score.toFixed(3)})`;
				const parts = [header];
				if (hit.context) parts.push(hit.context);
				parts.push(hit.content);
				return parts.join("\n");
			})
			.join("\n\n---\n\n");
	}

	static facets(query: string, view: FacetView): string {
		const header = `Facets for "${query}" (${view.labels.length} clusters):`;
		const lines = view.labels.map((label, i) => {
			const qualifiers = view.qualifiers?.[i] ?? [];
			return `- ${label}${qualifiers.length > 0 ? `: ${qualifiers.join(", ")}` : ""}`;
		});
		const footer =
			"\nPick a cluster and call `search` with a refined query that combines your original intent with the label + qualifiers to drill in.";
		return [header, ...lines, footer].join("\n");
	}

	static answer(result: ResearchResult): string {
		const parts = [result.answer];

		if (result.sources.length > 0) {
			parts.push(
				`\nSources:\n${result.sources
					.map((s) => `[${s.n}] ${s.path}:${s.startLine}-${s.endLine}`)
					.join("\n")}`,
			);
		}

		const queries = result.trace.flatMap((t) =>
			t.kind === "search" ? [`"${t.query}"`] : [],
		);
		const meta =
			`${result.steps} steps, ${(result.elapsedMs / 1000).toFixed(0)}s` +
			`${result.degraded ? ", degraded" : ""}`;
		parts.push(
			queries.length > 0
				? `\n(searched ${queries.join(", ")} · ${meta})`
				: `\n(${meta})`,
		);

		return parts.join("\n");
	}

	static projects(
		projects: ReadonlyArray<{ root: string; remote?: string }>,
	): string {
		const lines = projects.map((p) =>
			[p.root, ...(p.remote ? [`(${p.remote})`] : [])].join(" "),
		);
		return `Indexed projects:\n${lines.map((l) => `- ${l}`).join("\n")}`;
	}
}
