import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StateDirectoryPort } from "../../domain/ports/StateDirectoryPort.js";
import { PidFileLock } from "../fs/PidFileLock.js";
import type { ProjectMetadataStore } from "../fs/ProjectMetadataStore.js";

/** What kind of lmgrep invocation a process is. */
export type ProcessKind = "mcp" | "serve" | "cli";

/** A live lmgrep process holding a database's maintainer lock. */
export interface RunningProcess {
	pid: number;
	/** Process title from /proc/<pid>/comm (e.g. "lmgrep-mcp"). */
	processName: string;
	cmdline: string;
	kind: ProcessKind;
	/** Project root taken from the held index's metadata. */
	projectRoot?: string;
	/** Whether this process is watching the index for changes. */
	watching: boolean;
}

/**
 * Discovers which lmgrep processes are alive and what they hold.
 *
 * Maintainer lock files double as the registry: each records its owner's pid,
 * so scanning them and testing liveness gives an accurate picture without any
 * separate bookkeeping that could drift from reality.
 */
export class ProcessRegistry {
	private static readonly LOCK_SUFFIX = ".lock";

	constructor(
		private readonly state: StateDirectoryPort,
		private readonly metadata: ProjectMetadataStore,
	) {}

	discoverRunning(): RunningProcess[] {
		const base = this.state.root();
		let entries: string[];
		try {
			entries = readdirSync(base);
		} catch {
			return [];
		}

		const results: RunningProcess[] = [];
		// One process can hold several databases; report it once.
		const seen = new Set<number>();

		for (const entry of entries) {
			if (!entry.endsWith(ProcessRegistry.LOCK_SUFFIX)) continue;

			const pid = this.readPid(join(base, entry));
			if (pid === undefined) continue;
			if (!PidFileLock.isAlive(pid) || seen.has(pid)) continue;
			seen.add(pid);

			const info = this.inspect(pid);
			if (!info) continue;

			const kind = this.classify(info);
			const databasePath = join(
				base,
				entry.slice(0, -ProcessRegistry.LOCK_SUFFIX.length),
			);

			results.push({
				pid,
				processName: info.name,
				cmdline: info.cmdline,
				kind,
				projectRoot: this.metadata.read(databasePath)?.root,
				// MCP and serve processes watch; plain CLI invocations don't.
				watching: kind === "mcp" || kind === "serve",
			});
		}

		return results;
	}

	private readPid(lockPath: string): number | undefined {
		try {
			const pid = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
			return Number.isNaN(pid) ? undefined : pid;
		} catch {
			return undefined;
		}
	}

	private inspect(pid: number): { name: string; cmdline: string } | undefined {
		try {
			return {
				name: readFileSync(`/proc/${pid}/comm`, "utf-8").trim(),
				cmdline: readFileSync(`/proc/${pid}/cmdline`, "utf-8")
					.replace(/\0/g, " ")
					.trim(),
			};
		} catch {
			// No procfs (macOS) or the process exited mid-scan.
			return undefined;
		}
	}

	private classify(info: { name: string; cmdline: string }): ProcessKind {
		if (info.name === "lmgrep-mcp" || info.cmdline.includes("mcp")) {
			return "mcp";
		}
		if (info.cmdline.includes("serve")) return "serve";
		return "cli";
	}
}
