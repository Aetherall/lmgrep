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
	/** Separates the database slug from the worktree digest in a lock name. */
	private static readonly WORKTREE_SEPARATOR = "@";

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

			const owner = new PidFileLock(join(base, entry)).read();
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
				// would name the wrong tree. Older locks carry no root, so
				// fall back to the database metadata for those.
				projectRoot:
					owner.root ??
					this.metadata.read(this.databasePathFor(base, entry))?.root,
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
	 * The database a lock belongs to. Maintainer locks are named
	 * `<database>@<worktree-digest>.lock`; anything before the separator is the
	 * database directory.
	 */
	private databasePathFor(base: string, entry: string): string {
		const name = entry.slice(0, -ProcessRegistry.LOCK_SUFFIX.length);
		const separator = name.lastIndexOf(ProcessRegistry.WORKTREE_SEPARATOR);
		return join(base, separator === -1 ? name : name.slice(0, separator));
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
