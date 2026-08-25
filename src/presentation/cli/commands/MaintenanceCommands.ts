import { existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Command } from "commander";
import { ProjectMetadataStore } from "../../../infrastructure/fs/ProjectMetadataStore.js";
import { StateDirectory } from "../../../infrastructure/fs/StateDirectory.js";
import { CliOptions } from "../CliOptions.js";
import type { CommandContext, GlobalOptions } from "../CommandContext.js";

/**
 * `repair`, `compact` and `prune` — the commands that fix or remove an index.
 *
 * Grouped because they share one obligation: each mutates or destroys stored
 * data, so each verifies its target and reports precisely what it changed.
 */
export class MaintenanceCommands {
	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		this.registerRepair(program);
		this.registerCompact(program);
		this.registerPrune(program);
	}

	private registerRepair(program: Command): void {
		program
			.command("repair")
			.description(
				"Detect and fix index inconsistencies (orphaned/stale chunks)",
			)
			.option("-d, --dry", "Show what would be repaired without making changes")
			.option("--json", "Output repair results as JSON")
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action(
				async (options: GlobalOptions & { dry?: boolean; json?: boolean }) => {
					await this.context.withLmgrep(options, async (lmgrep) => {
						const result = await lmgrep.repair(options.dry);
						if (options.json) this.context.renderer.json(result);
					});
				},
			);
	}

	private registerCompact(program: Command): void {
		program
			.command("compact")
			.description(
				"Remove duplicate/stale chunks and compact the index to reclaim disk space",
			)
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action(async (options: GlobalOptions) => {
				await this.context.withLmgrep(options, async (lmgrep) => {
					const { renderer } = this.context;
					// Sweep first: dedupe keeps every version a manifest still
					// references, so a deleted branch's rows would shield its
					// own orphaned chunks from being collected.
					await lmgrep.sweepStaleBranches();
					const deduped = await lmgrep.maintenance.dedupe();
					renderer.line(
						deduped.duplicateIds + deduped.staleVersions > 0
							? `Removed ${deduped.duplicateIds} duplicate and ${deduped.staleVersions} stale chunks (${deduped.before} → ${deduped.after}).`
							: "No duplicate or stale chunks found.",
					);

					const report = await lmgrep.optimize();
					for (const table of report.tables) {
						if (table.action === "created") {
							renderer.line(
								`Built vector index on ${table.table} (${table.rows} rows).`,
							);
						} else if (table.action === "skipped-small") {
							renderer.line(
								`Skipped vector index on ${table.table}: only ${table.rows} rows.`,
							);
						}
					}
					renderer.line("Compaction complete.");
				});
			});
	}

	private registerPrune(program: Command): void {
		program
			.command("prune")
			.description("Delete the index database for the current directory")
			.option("--force", "Skip confirmation")
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action(async (options: GlobalOptions & { force?: boolean }) => {
				const { renderer } = this.context;
				const lmgrep = await this.context.open(options);
				const path = lmgrep.location.path;
				await lmgrep.close();

				if (!existsSync(path)) {
					renderer.line("No index found for this directory.");
					return;
				}

				// `--database <path>` can aim anywhere and this is a recursive
				// delete, so refuse anything that is not recognizably ours —
				// without this, `lmgrep prune --database .` removes a working tree.
				const metadata = new ProjectMetadataStore(new StateDirectory());
				if (!metadata.isDatabaseDirectory(path)) {
					renderer.error(
						`Refusing to delete ${path}: not an lmgrep database ` +
							"(no lmgrep.json or LanceDB tables). Check the --database value.",
					);
					process.exitCode = 1;
					return;
				}

				if (!options.force && !(await this.confirm(path))) {
					renderer.line("Cancelled.");
					return;
				}

				rmSync(path, { recursive: true, force: true });
				renderer.line(`Deleted ${path}`);
			});
	}

	private async confirm(path: string): Promise<boolean> {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		try {
			const answer = await new Promise<string>((resolve) => {
				rl.question(`Delete index at ${path}? [y/N] `, resolve);
			});
			return answer.trim().toLowerCase().startsWith("y");
		} finally {
			rl.close();
		}
	}
}
