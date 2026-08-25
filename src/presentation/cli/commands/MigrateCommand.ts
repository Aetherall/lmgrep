import { renameSync } from "node:fs";
import type { Command } from "commander";
import { IndexMigrationPlan } from "../../../application/operations/IndexMigrationPlan.js";
import { ProjectMetadataStore } from "../../../infrastructure/fs/ProjectMetadataStore.js";
import { StateDirectory } from "../../../infrastructure/fs/StateDirectory.js";
import type { CommandContext } from "../CommandContext.js";

/** `lmgrep migrate` — rename index directories to the current slug scheme. */
export class MigrateCommand {
	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		program
			.command("migrate")
			.description(
				"Rename existing index directories to match the current slug scheme",
			)
			.option("-d, --dry", "Show what would be migrated without making changes")
			.action((options: { dry?: boolean }) => this.run(options));
	}

	private async run(options: { dry?: boolean }): Promise<void> {
		const { renderer } = this.context;
		const state = new StateDirectory();
		const projects = new ProjectMetadataStore(state).discoverAll();

		if (projects.length === 0) {
			renderer.line("No indexed projects found.");
			return;
		}

		const moves = new IndexMigrationPlan(state).plan(projects);
		if (moves.length === 0) {
			renderer.line("All indexes already use the current slug scheme.");
			return;
		}

		renderer.line(`Found ${moves.length} index(es) to migrate:\n`);
		for (const move of moves) {
			renderer.line(
				`  ${move.from}\n  ${move.conflict ? "→ (conflict, skipped)" : "→"} ${move.to}\n`,
			);
		}

		const conflicts = moves.filter((m) => m.conflict);
		if (conflicts.length > 0) {
			renderer.line(
				`${conflicts.length} conflict(s): target already exists. ` +
					"These are likely sibling worktrees that already share a unified " +
					"index — delete the stale source manually with `rm -rf` after " +
					"verifying it's redundant.",
			);
		}

		if (options.dry) {
			renderer.line("\nDry run — no changes made.");
			return;
		}

		let migrated = 0;
		for (const move of moves) {
			if (move.conflict) continue;
			try {
				renameSync(move.from, move.to);
				migrated++;
			} catch (err) {
				renderer.error(
					`Failed to migrate ${move.from}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		renderer.line(`\nMigrated ${migrated} index(es).`);
	}
}
