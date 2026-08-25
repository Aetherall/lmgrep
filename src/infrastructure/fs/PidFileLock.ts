import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * A lock file holding the owning process's pid.
 *
 * The pid is what makes the lock recoverable: a process that dies without
 * cleaning up leaves a file behind, and the next contender takes it over once
 * it sees the pid is gone. Without that, one crash would wedge a database
 * until someone deleted the file by hand.
 */
export class PidFileLock {
	constructor(
		private readonly databasePath: string,
		private readonly suffix: string,
	) {}

	get path(): string {
		return `${this.databasePath}${this.suffix}`;
	}

	/** True when acquired; false when a live process already holds it. */
	tryAcquire(): boolean {
		if (this.isHeldByLiveProcess()) return false;
		mkdirSync(this.databasePath, { recursive: true });
		writeFileSync(this.path, `${process.pid}\n`);
		return true;
	}

	/** Release unconditionally — used by the long-lived maintainer lock. */
	release(): void {
		try {
			unlinkSync(this.path);
		} catch {}
	}

	/**
	 * Release only if this process still owns it, so a lock we already lost to
	 * a takeover is not deleted out from under its new owner.
	 */
	releaseIfOwned(): void {
		try {
			if (this.readPid() === process.pid) unlinkSync(this.path);
		} catch {}
	}

	isHeldByLiveProcess(): boolean {
		if (!existsSync(this.path)) return false;
		const pid = this.readPid();
		// An unreadable or corrupt lock is stale, and safe to take over.
		if (pid === undefined) return false;
		return PidFileLock.isAlive(pid);
	}

	private readPid(): number | undefined {
		try {
			const pid = Number.parseInt(readFileSync(this.path, "utf-8").trim(), 10);
			return Number.isNaN(pid) ? undefined : pid;
		} catch {
			return undefined;
		}
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
