import { randomBytes } from "node:crypto";
import {
	existsSync,
	linkSync,
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

	/**
	 * True when acquired; false when a live process already holds it.
	 *
	 * Checking for the file and then writing it let two processes that
	 * started together both see it free and both "acquire" it. The lock is
	 * instead written in full to a private draft and published with link(),
	 * which fails if the lock exists: exactly one contender can create it, and
	 * no reader ever sees a half-written lock and mistakes it for corrupt.
	 */
	tryAcquire(owner: Omit<LockOwner, "pid"> = {}): boolean {
		mkdirSync(dirname(this.path), { recursive: true });
		const body = `${JSON.stringify({ pid: process.pid, ...owner })}\n`;
		// A second attempt only after removing a dead owner's lock.
		for (let attempt = 0; attempt < 2; attempt++) {
			if (this.claim(this.path, body)) return true;
			if (!this.removeIfStale()) return false;
		}
		return false;
	}

	/** Create `path` holding `body`, only if it does not exist yet. */
	private claim(path: string, body: string): boolean {
		const draft = `${path}.draft.${process.pid}.${randomBytes(6).toString("hex")}`;
		writeFileSync(draft, body);
		try {
			linkSync(draft, path);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw err;
		} finally {
			PidFileLock.unlinkQuietly(draft);
		}
	}

	/**
	 * Remove the lock if its owner is dead; false when it cannot be taken.
	 *
	 * Contenders that all judge the same lock stale must not each remove it, or
	 * a slow one deletes the fresh lock a fast one just published. Removal
	 * therefore requires the takeover guard, itself claimed atomically. While
	 * it is held nobody else removes the lock, and nobody can publish over a
	 * lock that still exists — so a lock still stale under the guard is safe to
	 * delete.
	 */
	private removeIfStale(): boolean {
		if (this.isHeldByLiveProcess()) return false;
		const guard = `${this.path}.takeover`;
		const body = `${JSON.stringify({ pid: process.pid })}\n`;
		for (let attempt = 0; attempt < 2; attempt++) {
			if (this.claim(guard, body)) {
				try {
					// Re-read under the guard. An absent lock is left alone:
					// someone may publish into the gap at any moment, and
					// unlinking after they do would delete a live lock.
					if (!existsSync(this.path)) return true;
					if (this.isHeldByLiveProcess()) return false;
					PidFileLock.unlinkQuietly(this.path);
					return true;
				} finally {
					PidFileLock.unlinkQuietly(guard);
				}
			}
			// Another contender is mid-takeover and will publish. Only a guard
			// whose holder is known dead is cleared; an unreadable one was
			// most likely just released, and the retry claims it.
			const holder = PidFileLock.parse(PidFileLock.readQuietly(guard));
			if (holder && PidFileLock.isAlive(holder.pid)) return false;
			if (holder) PidFileLock.unlinkQuietly(guard);
		}
		return false;
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
		return PidFileLock.parse(PidFileLock.readQuietly(this.path));
	}

	private static readQuietly(path: string): string | undefined {
		try {
			return readFileSync(path, "utf-8");
		} catch {
			return undefined;
		}
	}

	private static unlinkQuietly(path: string): void {
		try {
			unlinkSync(path);
		} catch {}
	}

	private static parse(body: string | undefined): LockOwner | undefined {
		const raw = body?.trim();
		if (!raw) return undefined;

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
