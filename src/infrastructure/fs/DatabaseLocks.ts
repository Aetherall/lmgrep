import type { LockPort } from "../../domain/ports/LockPort.js";
import { PidFileLock } from "./PidFileLock.js";

/**
 * The two locks a database has, which exist for different reasons.
 *
 * The **maintainer** lock (`.lock`) is held for a watcher's whole lifetime and
 * doubles as the liveness registry `lmgrep status` reads. It cannot also serve
 * as a write mutex, or a one-shot `lmgrep index` could never run while a
 * watcher was up.
 *
 * The **write** mutex (`.writelock`) is short-lived and taken around each
 * build, so a watcher and an ad-hoc index serialize their writes instead of
 * racing into duplicate rows. It is deliberately named `.writelock` rather than
 * `.write.lock` so it does not match the `.lock` suffix scan used to discover
 * running processes.
 */
export class DatabaseLocks implements LockPort {
	private static readonly DEFAULT_WAIT_MS = 120_000;
	private static readonly DEFAULT_POLL_MS = 200;

	private readonly maintainer: PidFileLock;
	private readonly writer: PidFileLock;

	constructor(databasePath: string) {
		this.maintainer = new PidFileLock(databasePath, ".lock");
		this.writer = new PidFileLock(databasePath, ".writelock");
	}

	acquireMaintainer(): boolean {
		return this.maintainer.tryAcquire();
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
}
