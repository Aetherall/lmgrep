import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StateDirectoryPort } from "../../domain/ports/StateDirectoryPort.js";
import { PidFileLock } from "../fs/PidFileLock.js";

/** What kind of lmgrep invocation a process is. */
export type ProcessKind = "mcp" | "serve" | "cli";

/** A live lmgrep process holding a database's maintainer lock. */
export interface RunningProcess {
	pid: number;
	/** Process title from /proc/<pid>/comm (e.g. "lmgrep-mcp"). */
	processName: string;
	cmdline: string;
	kind: ProcessKind;
	/** Working tree this process watches. */
	projectRoot?: string;
	/** Database it holds. */
	databasePath?: string;
	/** Whether this process is watching the index for changes. */
	watching: boolean;
}

/**
 * Discovers which lmgrep processes are alive and what they hold.
 *
 * Maintainer lock files double as the registry: each records its owner's pid,
 * worktree and database, so scanning them and testing liveness gives an
 * accurate picture without any separate bookkeeping that could drift from
 * reality.
 */
export class ProcessRegistry {
	private static readonly LOCK_SUFFIX = ".lock";

	constructor(private readonly state: StateDirectoryPort) {}

	discoverRunning(): RunningProcess[] {
		const results: RunningProcess[] = [];
		// One process can hold several databases; report it once.
		const seen = new Set<number>();

		for (const path of this.lockFiles()) {
			const owner = new PidFileLock(path).read();
			if (owner === undefined) continue;
			if (!PidFileLock.isAlive(owner.pid) || seen.has(owner.pid)) continue;
			seen.add(owner.pid);

			const info = this.inspect(owner.pid);
			if (!info) continue;

			results.push({
				pid: owner.pid,
				processName: info.name,
				cmdline: info.cmdline,
				kind: this.classify(info),
				// The lock records the worktree its owner actually watches,
				// which is what the user wants to see — several worktrees can
				// share one database, so the database's own recorded root
				// would name the wrong tree.
				projectRoot: owner.root,
				databasePath: owner.database,
				// Every lock in this scan is a maintainer lock, and only a
				// watcher ever takes one — so holding it *is* watching. This
				// used to be inferred from the command line, which cannot
				// work: setting process.title overwrites that buffer, so the
				// subcommand a process was launched with is no longer there
				// to match against.
				watching: true,
			});
		}

		return results;
	}

	/**
	 * Lock files, from the locks directory and from the state root.
	 *
	 * The root is scanned too because a watcher started before locks moved is
	 * still running and still holds its database — reporting "no running
	 * processes" right after an upgrade would be wrong in exactly the moment
	 * someone is most likely to check.
	 */
	private lockFiles(): string[] {
		const out: string[] = [];
		for (const directory of [this.state.locksDirectory(), this.state.root()]) {
			let entries: string[];
			try {
				entries = readdirSync(directory);
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (entry.endsWith(ProcessRegistry.LOCK_SUFFIX)) {
					out.push(join(directory, entry));
				}
			}
		}
		return out;
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

	/**
	 * What kind of process this is, from its title.
	 *
	 * The title is the only reliable signal: `process.title` rewrites the argv
	 * buffer, so /proc/<pid>/cmdline reads back as the title alone and carries
	 * no subcommand. The MCP entry point titles itself distinctly; anything
	 * else holding a maintainer lock reached it through `lmgrep serve`.
	 */
	private classify(info: { name: string; cmdline: string }): ProcessKind {
		if (info.name === "lmgrep-mcp" || info.cmdline.includes("mcp")) {
			return "mcp";
		}
		return "serve";
	}
}
