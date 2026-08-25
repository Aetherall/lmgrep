import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LockPort } from "../../domain/ports/LockPort.js";
import { PidFileLock } from "./PidFileLock.js";

/**
 * The two locks a database has, which exist for different reasons and are
 * therefore scoped differently.
 *
 * The **write mutex** (`.writelock`) is per *database*, because that is what
 * concurrent writers actually contend for: two indexers writing the same
 * tables race into duplicate rows. It is held only around a build.
 *
 * The **maintainer** lock is per *worktree*. Watching is inherently per
 * working tree — a watcher scans its own root and maintains its own branch's
 * manifest — but worktrees of one repository share a single database. Keying
 * this lock by database, as it once was, meant the first worktree to start
 * silently prevented every sibling from ever watching, leaving their branches
 * to go stale with no indication. It also doubles as the liveness registry
 * `lmgrep status` reads, which is why the owning worktree is recorded in it.
 *
 * Both live in the state directory rather than beside the database. Locks
 * coordinate processes on *this machine*; a database now lives inside a
 * repository, which may be on a network filesystem, may be read-only, and is
 * the wrong place to record which local pid is busy with it. Keeping them
 * together in one directory is also what lets `status` find every running
 * lmgrep by reading a single directory.
 */
export class DatabaseLocks implements LockPort {
	private static readonly DEFAULT_WAIT_MS = 120_000;
	private static readonly DEFAULT_POLL_MS = 200;
	/** Enough to separate worktrees without making the filename unreadable. */
	private static readonly ROOT_DIGEST_LENGTH = 12;

	private readonly maintainer: PidFileLock;
	private readonly writer: PidFileLock;

	constructor(
		locksDirectory: string,
		private readonly databasePath: string,
		/** Working tree this process would be responsible for. */
		private readonly workspaceRoot: string,
	) {
		const database = DatabaseLocks.digestOf(databasePath);
		this.maintainer = new PidFileLock(
			join(
				locksDirectory,
				`${database}@${DatabaseLocks.digestOf(workspaceRoot)}.lock`,
			),
		);
		this.writer = new PidFileLock(
			join(locksDirectory, `${database}.writelock`),
		);
	}

	acquireMaintainer(): boolean {
		// The database path goes in the payload because it is no longer in the
		// filename: a digest cannot be reversed, and `status` needs to name the
		// index a process is holding.
		return this.maintainer.tryAcquire({
			root: this.workspaceRoot,
			database: this.databasePath,
		});
	}

	releaseMaintainer(): void {
		this.maintainer.release();
	}

	isMaintained(): boolean {
		return this.maintainer.isHeldByLiveProcess();
	}

	/**
	 * Run `fn` holding the write mutex. Waits for a busy lock, taking over one
	 * whose owner has died. Throws if it cannot be acquired in time — better to
	 * fail than to write concurrently and duplicate rows.
	 */
	async withWriteLock<T>(
		fn: () => Promise<T>,
		options: { waitMs?: number; pollMs?: number } = {},
	): Promise<T> {
		const waitMs = options.waitMs ?? DatabaseLocks.DEFAULT_WAIT_MS;
		const pollMs = options.pollMs ?? DatabaseLocks.DEFAULT_POLL_MS;

		let waited = 0;
		while (!this.writer.tryAcquire()) {
			if (waited >= waitMs) {
				throw new Error(
					"Could not acquire the index write lock — another indexer is busy. " +
						"Try again once it finishes.",
				);
			}
			await new Promise((r) => setTimeout(r, pollMs));
			waited += pollMs;
		}

		try {
			return await fn();
		} finally {
			this.writer.releaseIfOwned();
		}
	}

	/** Short stable name for a path, used to key lock files. */
	private static digestOf(path: string): string {
		return createHash("sha256")
			.update(path)
			.digest("hex")
			.slice(0, DatabaseLocks.ROOT_DIGEST_LENGTH);
	}
}
