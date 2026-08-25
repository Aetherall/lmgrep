import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** What a lock records about its owner. */
export interface LockOwner {
	pid: number;
	/** Working tree the owner is responsible for, when it has one. */
	root?: string;
	/** Database the owner holds. Lock files no longer sit beside it. */
	database?: string;
}

/**
 * A lock file recording its owning process.
 *
 * The pid is what makes the lock recoverable: a process that dies without
 * cleaning up leaves the file behind, and the next contender takes it over
 * once it sees the owner is gone. Without that, one crash would wedge a
 * database until someone deleted the file by hand.
 */
export class PidFileLock {
	constructor(readonly path: string) {}

	/** True when acquired; false when a live process already holds it. */
	tryAcquire(owner: Omit<LockOwner, "pid"> = {}): boolean {
		if (this.isHeldByLiveProcess()) return false;
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(
			this.path,
			`${JSON.stringify({ pid: process.pid, ...owner })}\n`,
		);
		return true;
	}

	/** Release unconditionally — used by the long-lived maintainer lock. */
	release(): void {
		try {
			unlinkSync(this.path);
		} catch {}
	}

	/**
	 * Release only if this process still owns it, so a lock already lost to a
	 * takeover is not deleted out from under its new owner.
	 */
	releaseIfOwned(): void {
		try {
			if (this.read()?.pid === process.pid) unlinkSync(this.path);
		} catch {}
	}

	isHeldByLiveProcess(): boolean {
		if (!existsSync(this.path)) return false;
		const owner = this.read();
		// An unreadable or corrupt lock is stale, and safe to take over.
		if (owner === undefined) return false;
		return PidFileLock.isAlive(owner.pid);
	}

	/**
	 * Parse the lock body.
	 *
	 * Locks written before this carried a bare pid, and a stale one of those
	 * must still be recognised — otherwise an upgrade would treat a live
	 * watcher's lock as free and start a second one.
	 */
	read(): LockOwner | undefined {
		let raw: string;
		try {
			raw = readFileSync(this.path, "utf-8").trim();
		} catch {
			return undefined;
		}
		if (raw.length === 0) return undefined;

		if (raw.startsWith("{")) {
			try {
				const parsed = JSON.parse(raw) as Partial<LockOwner>;
				return typeof parsed.pid === "number"
					? {
							pid: parsed.pid,
							root: parsed.root,
							database: parsed.database,
						}
					: undefined;
			} catch {
				return undefined;
			}
		}

		const pid = Number.parseInt(raw, 10);
		return Number.isNaN(pid) ? undefined : { pid };
	}

	/** Signal 0 tests for existence without delivering anything. */
	static isAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}
}
