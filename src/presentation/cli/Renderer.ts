import type { FacetView } from "../../application/faceting/FacetNavigator.js";
import type { StatusInfo } from "../../application/operations/StatusService.js";
import type { TraceEntry } from "../../domain/research/ResearchTrace.js";
import type { Hit } from "../../domain/retrieval/Hit.js";
import type { RunningProcess } from "../../infrastructure/process/ProcessRegistry.js";

/**
 * All terminal output for the CLI.
 *
 * Separated from the commands so that what a command *does* and how it *reads*
 * are independently changeable — the commands became testable the moment they
 * stopped calling console.log directly.
 */
export class Renderer {
	private static readonly RULE_WIDTH = 60;

	constructor(private readonly out: (line: string) => void = console.log) {}

	line(text = ""): void {
		this.out(text);
	}

	rule(): void {
		this.out("─".repeat(Renderer.RULE_WIDTH));
	}

	json(value: unknown): void {
		this.out(JSON.stringify(value, null, 2));
	}

	/** Full result view: a ruled header, the context block, then the source. */
	hits(hits: readonly Hit[], options: { scores?: boolean } = {}): void {
		for (const hit of hits) {
			const score = options.scores ? ` (score: ${hit.score.toFixed(3)})` : "";
			this.out(`\n${"─".repeat(Renderer.RULE_WIDTH)}`);
			this.out(`${hit.location} [${hit.type}] ${hit.name}${score}`);
			this.rule();
			this.out(hit.context);
			this.out("");
			this.out(hit.content);
		}
	}

	/** Just the distinct file paths, in first-hit order. */
	hitPaths(hits: readonly Hit[]): void {
		const seen = new Set<string>();
		for (const hit of hits) {
			if (seen.has(hit.location.filePath)) continue;
			seen.add(hit.location.filePath);
			this.out(hit.location.filePath);
		}
	}

	/** `label: qualifier, qualifier` — the default compact facet listing. */
	facetLabels(view: FacetView): void {
		view.labels.forEach((label, i) => {
			const qualifiers = view.qualifiers?.[i] ?? [];
			this.out(
				qualifiers.length === 0
					? `  ${label}`
					: `  ${label}: ${qualifiers.join(", ")}`,
			);
		});
	}

	/**
	 * Verbose listing: each cluster's alternative terms, then what separates it
	 * from each sibling individually.
	 */
	facetDetail(view: FacetView): void {
		view.labels.forEach((label, i) => {
			const [head, ...rest] = view.candidates?.[i] ?? [label];
			this.out(`  ${head}${rest.length > 0 ? ` (${rest.join(", ")})` : ""}`);
			for (const row of view.disambiguators?.[i] ?? []) {
				this.out(`    vs ${row.vs}: ${row.terms.join(", ")}`);
			}
		});
	}

	/** One research step, written to stderr so stdout stays pipeable. */
	static formatTrace(entry: TraceEntry): string {
		return entry.kind === "search"
			? `  search  "${entry.query}" → ${entry.hits} hits`
			: `  · ${entry.message}`;
	}

	/** Configuration and paths — shown even when there is no index yet. */
	statusHeader(info: StatusInfo): void {
		this.out(`Project root: ${info.projectRoot}`);
		if (info.prefix) this.out(`Subdirectory: ${info.prefix}`);
		this.out(`Model: ${info.config.model}`);
		if (info.config.provider) this.out(`Provider: ${info.config.provider}`);
		if (info.config.baseURL) this.out(`Base URL: ${info.config.baseURL}`);
		this.out(`Batch size: ${info.config.batchSize}`);
		if (info.config.maxTokens) {
			this.out(`Max tokens: ${info.config.maxTokens}`);
		}
	}

	statusStats(info: StatusInfo): void {
		this.out("\nIndex stats:");
		this.out(`  Files: ${info.fileCount}`);
		this.out(`  Chunks: ${info.chunkCount}`);
		this.out(`  Unique hashes: ${info.uniqueHashes}`);
		if (info.indexModel) this.out(`  Index model: ${info.indexModel}`);
		if (info.indexDimensions) {
			this.out(`  Dimensions: ${info.indexDimensions}`);
		}
		// A gap between rows and distinct hashes means duplicate chunks, which
		// `lmgrep compact` removes.
		if (info.chunkCount !== info.uniqueHashes) {
			this.out(`  Duplicates: ${info.chunkCount - info.uniqueHashes}`);
		}
	}

	statusChecks(info: StatusInfo): void {
		this.out("\nEmbedding check:");
		if (info.embeddingOk) {
			this.out(`  OK (${info.embeddingLatencyMs}ms)`);
		} else {
			this.out("  FAILED");
			for (const line of (info.embeddingError ?? "").split("\n")) {
				if (info.embeddingError) this.out(`  ${line}`);
			}
		}

		this.out("\nSearch check:");
		if (info.searchOk) {
			this.out(
				`  OK (${info.searchResultCount} result, ${info.searchLatencyMs}ms)`,
			);
		} else if (info.embeddingOk && info.fileCount > 0) {
			this.out("  FAILED (query returned no results)");
		} else {
			this.out("  SKIPPED");
		}
	}

	/** Who else is holding this index, and whether they are watching it. */
	runningProcesses(processes: readonly RunningProcess[]): void {
		if (processes.length === 0) {
			this.out("\nNo running lmgrep processes.");
			return;
		}
		this.out("\nRunning processes:");
		for (const proc of processes) {
			const label =
				proc.kind === "mcp"
					? "MCP server"
					: proc.kind === "serve"
						? "serve"
						: "CLI";
			this.out(
				`  ${label} (pid ${proc.pid})${proc.watching ? ", watching" : ""}`,
			);
			this.out(`    index: ${proc.projectRoot ?? "unknown"}`);
		}
	}

	/** Working-tree drift, truncated so a large diff stays readable. */
	changes(changes: {
		added: string[];
		modified: string[];
		deleted: string[];
	}): void {
		const total =
			changes.added.length + changes.modified.length + changes.deleted.length;
		if (total === 0) {
			this.out("  No changes detected.");
			return;
		}
		this.changeGroup("Added", "+", changes.added);
		this.changeGroup("Modified", "~", changes.modified);
		this.changeGroup("Deleted", "-", changes.deleted);
		this.out("\n  Run `lmgrep index` to update the index.");
	}

	private changeGroup(label: string, marker: string, files: string[]): void {
		if (files.length === 0) return;
		const SHOWN = 10;
		this.out(`  ${label}: ${files.length}`);
		for (const f of files.slice(0, SHOWN)) this.out(`    ${marker} ${f}`);
		if (files.length > SHOWN) {
			this.out(`    ... and ${files.length - SHOWN} more`);
		}
	}

	error(message: string): void {
		console.error(message);
	}
}
