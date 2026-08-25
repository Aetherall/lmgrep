import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";
import {
	IndexInventory,
	type InventoryEntry,
} from "../../../application/operations/IndexInventory.js";
import { ModelIdentity } from "../../../domain/project/ModelIdentity.js";
import { ProjectLocator } from "../../../domain/project/ProjectLocator.js";
import { ConfigLoader } from "../../../infrastructure/fs/ConfigLoader.js";
import { DiskUsage } from "../../../infrastructure/fs/DiskUsage.js";
import { ProjectMetadataStore } from "../../../infrastructure/fs/ProjectMetadataStore.js";
import { ProjectRegistry } from "../../../infrastructure/fs/ProjectRegistry.js";
import { StateDirectory } from "../../../infrastructure/fs/StateDirectory.js";
import { GitClient } from "../../../infrastructure/git/GitClient.js";
import type { CommandContext } from "../CommandContext.js";

/**
 * `lmgrep projects` — every index on this machine, and what to do about it.
 *
 * This is the answer to the state lmgrep used to accumulate silently. An index
 * now lives inside the repository it describes, so deleting the clone deletes
 * the index; but installs that predate that still hold databases in the state
 * directory, pointing at working trees that may be long gone. `adopt` moves
 * one into its repository without re-embedding, `rm` deletes one, and `gc`
 * removes the ones whose project no longer exists.
 */
export class ProjectsCommand {
	private readonly state = new StateDirectory();
	private readonly metadata = new ProjectMetadataStore();
	private readonly registry = new ProjectRegistry(this.state);

	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		const projects = program
			.command("projects")
			.description("List indexes on this machine, and reclaim their space");

		projects
			.command("list", { isDefault: true })
			.description("Show every index, largest first")
			.option("--json", "Print the inventory as JSON")
			.action((options: { json?: boolean }) => this.list(options));

		projects
			.command("adopt")
			.description(
				"Move this project's index from the state directory into the repository",
			)
			.action(() => this.adopt());

		projects
			.command("rm [database]")
			.description(
				"Delete an index — this project's, or the database path given",
			)
			.option("--force", "Skip confirmation")
			.action((database: string | undefined, options: { force?: boolean }) =>
				this.remove(database, options),
			);

		projects
			.command("gc")
			.description(
				"Delete indexes whose project no longer exists, and forget dead pointers",
			)
			.option("--force", "Skip confirmation")
			.option("-d, --dry", "Show what would be deleted, and stop")
			.action((options: { force?: boolean; dry?: boolean }) =>
				this.collect(options),
			);
	}

	private list(options: { json?: boolean }): void {
		const inventory = this.inventory().collect();
		if (options.json) {
			this.context.renderer.json(inventory);
			return;
		}
		this.context.renderer.inventory(inventory);
	}

	/**
	 * Move a legacy database into its repository.
	 *
	 * Worth doing rather than re-indexing because the expensive part of an
	 * index is the embedding, not the storage — a large corpus is minutes of
	 * model time to rebuild and a rename to move. The destination is derived
	 * from the model the database *was built with*, not the one currently
	 * configured, so it lands where searches with that model will look.
	 */
	private async adopt(): Promise<void> {
		const { renderer, cwd } = this.context;
		const locator = this.locator();
		const home = locator.indexHomeFor(cwd);

		const candidates = this.inventory()
			.collect()
			.entries.filter(
				(e) => e.kind === "legacy" && e.root && this.sameProject(e, cwd),
			);

		if (candidates.length === 0) {
			renderer.line("No legacy index found for this project.");
			renderer.line(`Its index would live at ${home}`);
			return;
		}

		for (const entry of candidates) {
			if (!entry.model) {
				renderer.error(
					`Skipping ${entry.databasePath}: it does not record which model built it, ` +
						"so there is no way to tell which index it is. Delete it with `lmgrep projects rm`.",
				);
				continue;
			}
			const target = locator.databasePathForModel(
				cwd,
				ModelIdentity.of(entry.model),
			);
			if (existsSync(target)) {
				renderer.error(
					`Skipping ${entry.databasePath}: ${target} already exists.`,
				);
				continue;
			}
			this.move(entry.databasePath, target);
			this.registry.record({
				root: locator.projectRootFor(cwd),
				remote: entry.remote,
				databasePath: target,
				model: entry.model,
				dimensions: entry.dimensions,
			});
			renderer.line(
				`Adopted ${DiskUsage.format(entry.bytes)} — ${entry.model}\n  ${entry.databasePath}\n  → ${target}`,
			);
		}
	}

	private async remove(
		database: string | undefined,
		options: { force?: boolean },
	): Promise<void> {
		const { renderer } = this.context;
		const path = database ?? this.locator().databasePathFor(this.context.cwd);

		if (!existsSync(path)) {
			renderer.line(`No index at ${path}`);
			return;
		}
		// This is a recursive delete and the path can come from the command
		// line, so refuse anything that is not recognizably ours — without
		// this, a mistyped argument removes a working tree.
		if (!this.metadata.isDatabaseDirectory(path)) {
			renderer.error(
				`Refusing to delete ${path}: not an lmgrep database ` +
					"(no lmgrep.json or LanceDB tables).",
			);
			process.exitCode = 1;
			return;
		}
		if (!options.force && !(await this.confirm(`Delete index at ${path}?`))) {
			renderer.line("Cancelled.");
			return;
		}

		const bytes = DiskUsage.of(path);
		rmSync(path, { recursive: true, force: true });
		this.registry.forget(path);
		renderer.line(`Deleted ${path} (${DiskUsage.format(bytes)})`);
	}

	private async collect(options: {
		force?: boolean;
		dry?: boolean;
	}): Promise<void> {
		const { renderer } = this.context;
		const inventory = this.inventory().collect();
		const dead = inventory.entries.filter((e) => !e.rootExists);

		if (dead.length === 0 && inventory.dangling === 0) {
			renderer.line("Nothing to collect — every index has a project.");
			return;
		}

		if (dead.length > 0) {
			const bytes = dead.reduce((sum, e) => sum + e.bytes, 0);
			renderer.line(
				`${dead.length} index(es) whose project is gone — ${DiskUsage.format(bytes)}:\n`,
			);
			for (const entry of dead) {
				renderer.line(
					`  ${DiskUsage.format(entry.bytes).padStart(6)}  ${entry.root ?? "(unknown project)"}`,
				);
				renderer.line(`          ${entry.databasePath}`);
			}
		}
		if (inventory.dangling > 0) {
			renderer.line(
				`\n${inventory.dangling} registry pointer(s) to databases that no longer exist.`,
			);
		}

		if (options.dry) {
			renderer.line("\nDry run — nothing deleted.");
			return;
		}
		if (!options.force && !(await this.confirm("\nDelete all of the above?"))) {
			renderer.line("Cancelled.");
			return;
		}

		let reclaimed = 0;
		for (const entry of dead) {
			// An index with no recorded project could be anything, including a
			// directory someone aimed `--in` at. Verify before recursing.
			if (!this.metadata.isDatabaseDirectory(entry.databasePath)) {
				renderer.error(
					`Skipped ${entry.databasePath}: not an lmgrep database.`,
				);
				continue;
			}
			rmSync(entry.databasePath, { recursive: true, force: true });
			this.registry.forget(entry.databasePath);
			reclaimed += entry.bytes;
		}
		for (const entry of this.registry.dangling()) {
			this.registry.forget(entry.databasePath);
		}
		renderer.line(`Reclaimed ${DiskUsage.format(reclaimed)}.`);
	}

	/** Whether a legacy entry describes the project at `cwd`. */
	private sameProject(entry: InventoryEntry, cwd: string): boolean {
		const project = this.locator().resolveProject(cwd);
		if (entry.remote && project.remote) return entry.remote === project.remote;
		return entry.root === project.root;
	}

	/** Rename when possible; copy across filesystems, which repos often are. */
	private move(from: string, to: string): void {
		mkdirSync(dirname(to), { recursive: true });
		try {
			renameSync(from, to);
		} catch {
			cpSync(from, to, { recursive: true });
			rmSync(from, { recursive: true, force: true });
		}
	}

	private inventory(): IndexInventory {
		return new IndexInventory(
			this.registry,
			this.metadata,
			this.state,
			(path) => DiskUsage.of(path),
		);
	}

	private locator(): ProjectLocator {
		const config = new ConfigLoader().load(this.context.cwd);
		return new ProjectLocator(
			new GitClient(),
			this.state,
			ModelIdentity.of(config.model),
			config.dimensions,
		);
	}

	private async confirm(question: string): Promise<boolean> {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		try {
			const answer = await new Promise<string>((resolve) => {
				rl.question(`${question} [y/N] `, resolve);
			});
			return answer.trim().toLowerCase().startsWith("y");
		} finally {
			rl.close();
		}
	}
}
