import type { TidyReport } from "../../application/Lmgrep.js";
import type { Inventory } from "../../application/operations/IndexInventory.js";
import type { StatusInfo } from "../../application/operations/StatusService.js";
import type { TraceEntry } from "../../domain/research/ResearchTrace.js";
import type { Hit } from "../../domain/retrieval/Hit.js";
import { DiskUsage } from "../../infrastructure/fs/DiskUsage.js";
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

	/**
	 * Full result view: a ruled header, the context block, then the source.
	 *
	 * The score is always shown. It used to be behind `--scores`, which meant
	 * the one number that says how much to trust a result was hidden by
	 * default and cost a flag to see.
	 */
	hits(hits: readonly Hit[]): void {
		for (const hit of hits) {
			const score = ` (${hit.score.toFixed(3)})`;
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

	/** One research step, written to stderr so stdout stays pipeable. */
	static formatTrace(entry: TraceEntry): string {
		return entry.kind === "search"
			? `  search  "${entry.query}" → ${entry.hits} hits`
			: `  · ${entry.message}`;
	}

	/**
	 * The verdict, first and alone.
	 *
	 * Everything below it is detail for when the answer is "no". This line is
	 * the whole reason to run the command.
	 */
	statusVerdict(info: StatusInfo): void {
		if (!info.verdict.searchable) {
			this.out(`Not searchable — ${info.verdict.reason}`);
			this.out(`  Fix: ${info.verdict.fix}`);
			return;
		}
		this.out("Searchable.");
		if (info.verdict.note) this.out(`  Note: ${info.verdict.note}`);
	}

	/** Configuration and paths — shown even when there is no index yet. */
	statusHeader(info: StatusInfo): void {
		this.out(`\nProject: ${info.projectRoot}`);
		if (info.prefix) this.out(`Subdirectory: ${info.prefix}`);
		this.out(`Index:   ${info.databasePath}`);
		this.out(`Model:   ${info.config.model}`);
		if (info.config.baseURL) this.out(`Server:  ${info.config.baseURL}`);
	}

	/**
	 * Which file supplied which settings.
	 *
	 * Worth a section of its own because the alternative is guessing. With two
	 * files able to set the same key, an effective value printed on its own
	 * tells you what lmgrep decided but not where to go to change it — which
	 * is the actual question when the answer surprises you.
	 */
	statusConfig(info: StatusInfo): void {
		this.out("\nConfiguration:");
		if (info.configSources.length === 0) {
			this.out("  (none — defaults only)");
			return;
		}
		for (const source of info.configSources) {
			const marks = [
				source.scope === "project" ? "project" : "machine",
				source.deprecated ? "deprecated location" : undefined,
			].filter(Boolean);
			this.out(`  ${source.path}  [${marks.join(", ")}]`);
			this.out(`    ${source.keys.join(", ") || "(nothing applied)"}`);
		}
		if (info.configSources.length > 1) {
			this.out("  Later files override earlier ones, key by key.");
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
		this.vectorIndex(info.vectorIndex);
	}

	/**
	 * How searches are answered.
	 *
	 * Worth its own line because the difference is invisible otherwise: without
	 * an index every query scans every embedding, costing roughly the index's
	 * size in memory and an order of magnitude in latency. Nothing else tells
	 * the user that is happening.
	 */
	private vectorIndex(state: StatusInfo["vectorIndex"]): void {
		if (state.built) {
			this.out(
				state.unindexed > 0
					? `  Vector index: yes (${state.unindexed} rows awaiting the next optimize)`
					: "  Vector index: yes",
			);
			return;
		}
		if (!state.worthBuilding) {
			this.out("  Vector index: not needed at this size");
			return;
		}
		this.out(
			"  Vector index: MISSING — every search scans all " +
				`${state.rows} embeddings. Run \`lmgrep index\` to build it.`,
		);
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

	/** What a maintenance pass changed; silent when it changed nothing. */
	maintenance(report: TidyReport): void {
		const { duplicateIds, staleVersions, before, after } = report.deduped;
		if (duplicateIds + staleVersions > 0) {
			this.out(
				`Removed ${duplicateIds} duplicate and ${staleVersions} superseded chunks (${before} → ${after}).`,
			);
		}
		for (const table of report.optimized.tables) {
			if (table.action === "created") {
				this.out(`Built vector index on ${table.table} (${table.rows} rows).`);
			} else if (table.action === "dropped") {
				this.out(
					`Dropped the unused ${table.table} table (${table.rows} rows).`,
				);
			}
		}
	}

	/**
	 * Every index on this machine.
	 *
	 * Sorted by size and leading with the total, because the question this
	 * answers is almost always "what is using my disk, and can I delete it".
	 */
	inventory(inventory: Inventory): void {
		if (inventory.entries.length === 0) {
			this.out(
				"No indexes on this machine yet. Run `lmgrep index` in a project.",
			);
			return;
		}

		for (const entry of inventory.entries) {
			const marks = [
				entry.kind === "legacy" ? "legacy" : undefined,
				entry.name ? "standalone" : undefined,
				entry.rootExists ? undefined : "project gone",
			].filter(Boolean);
			this.out(
				`${DiskUsage.format(entry.bytes).padStart(7)}  ${entry.name ?? entry.root ?? "(unknown project)"}` +
					(marks.length > 0 ? `  [${marks.join(", ")}]` : ""),
			);
			this.out(
				`         ${entry.model ?? "unknown model"}${entry.dimensions ? ` · ${entry.dimensions} dims` : ""}`,
			);
			this.out(`         ${entry.databasePath}`);
		}

		this.out(
			`\n${inventory.entries.length} index(es), ${DiskUsage.format(inventory.totalBytes)} total.`,
		);

		const legacy = inventory.entries.filter((e) => e.kind === "legacy").length;
		const dead = inventory.entries.filter((e) => !e.rootExists).length;
		if (legacy > 0) {
			this.out(
				`${legacy} still in the state directory — run \`lmgrep projects adopt\` in each project to move them in.`,
			);
		}
		if (dead > 0) {
			this.out(
				`${dead} whose project no longer exists — \`lmgrep projects gc\` reclaims them.`,
			);
		}
		if (inventory.dangling > 0) {
			this.out(
				`${inventory.dangling} stale pointer(s) to deleted indexes — \`lmgrep projects gc\` forgets them.`,
			);
		}
	}

	error(message: string): void {
		console.error(message);
	}
}
