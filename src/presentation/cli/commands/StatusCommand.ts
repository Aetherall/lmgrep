import type { Command } from "commander";
import { WorkingTreeDiff } from "../../../application/operations/WorkingTreeDiff.js";
import { StateDirectory } from "../../../infrastructure/fs/StateDirectory.js";
import { Workspace } from "../../../infrastructure/fs/Workspace.js";
import { ProcessRegistry } from "../../../infrastructure/process/ProcessRegistry.js";
import { CliOptions } from "../CliOptions.js";
import type { CommandContext, GlobalOptions } from "../CommandContext.js";

interface StatusOptions extends GlobalOptions {
	changes?: boolean;
	verbose?: boolean;
	json?: boolean;
}

/**
 * `lmgrep status` — is search working, and if not, what to do.
 *
 * It leads with that one answer. The statistics behind it used to *be* the
 * output, which left every reader to work out the verdict themselves from
 * fifteen lines of counts and latencies.
 */
export class StatusCommand {
	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		CliOptions.target(
			program
				.command("status")
				.description("Report whether search works, and why not")
				.option("-v, --verbose", "Also show index statistics and probes")
				.option("-c, --changes", "Scan for files changed since the last index")
				.option("--json", "Print status as JSON"),
		).action((options: StatusOptions) => this.run(options));
	}

	private async run(options: StatusOptions): Promise<void> {
		const processes = new ProcessRegistry(
			new StateDirectory(),
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

			renderer.statusVerdict(info);
			renderer.statusHeader(info);
			renderer.statusConfig(info);

			if (options.verbose) {
				renderer.statusStats(info);
				renderer.statusChecks(info);
				renderer.runningProcesses(processes);
			}

			if (changes) {
				renderer.line("\nScanning for changes...");
				renderer.changes(changes);
			}
		});
	}
}
