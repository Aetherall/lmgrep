import type { Command } from "commander";
import { WorkingTreeDiff } from "../../../application/operations/WorkingTreeDiff.js";
import { ProjectMetadataStore } from "../../../infrastructure/fs/ProjectMetadataStore.js";
import { StateDirectory } from "../../../infrastructure/fs/StateDirectory.js";
import { Workspace } from "../../../infrastructure/fs/Workspace.js";
import { ProcessRegistry } from "../../../infrastructure/process/ProcessRegistry.js";
import { CliOptions } from "../CliOptions.js";
import type { CommandContext, GlobalOptions } from "../CommandContext.js";

interface StatusOptions extends GlobalOptions {
	changes?: boolean;
	json?: boolean;
}

/**
 * `lmgrep status` — what is indexed, whether it works, and who is holding it.
 *
 * This is the diagnostic command, so it reports each concern separately:
 * configuration, index contents, the two liveness probes, and running
 * processes. Collapsing them into one verdict would hide which part is broken.
 */
export class StatusCommand {
	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		program
			.command("status")
			.description("Show index stats and check embedding connectivity")
			.option("-c, --changes", "Scan for changed files since last index")
			.option("--json", "Output status as JSON")
			.option("--database <name-or-path>", CliOptions.DATABASE)
			.action((options: StatusOptions) => this.run(options));
	}

	private async run(options: StatusOptions): Promise<void> {
		const state = new StateDirectory();
		const processes = new ProcessRegistry(
			state,
			new ProjectMetadataStore(state),
		).discoverRunning();

		await this.context.withLmgrep(options, async (lmgrep) => {
			const info = await lmgrep.status();
			const { renderer } = this.context;

			const changes = options.changes
				? new WorkingTreeDiff(new Workspace()).compute(
						info.projectRoot,
						await lmgrep.currentManifest(),
					)
				: undefined;

			if (options.json) {
				renderer.json({ ...info, processes, ...(changes ? { changes } : {}) });
				return;
			}

			renderer.statusHeader(info);
			if (info.fileCount === 0) {
				renderer.line("\nNo index found. Run `lmgrep index` first.");
				return;
			}

			renderer.statusStats(info);
			renderer.statusChecks(info);
			renderer.runningProcesses(processes);

			if (changes) {
				renderer.line("\nScanning for changes...");
				renderer.changes(changes);
			}
		});
	}
}
