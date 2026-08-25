/**
 * The two locks guarding a database.
 *
 * They are separate because they answer different questions: the maintainer
 * lock says "one process owns watching this index" and lives as long as that
 * process, while the write mutex says "one writer at a time" and is held only
 * around a build. Collapsing them would stop an ad-hoc index from ever running
 * beside a watcher.
 */
export interface LockPort {
	/** Claim long-lived ownership. False when another live process holds it. */
	acquireMaintainer(): boolean;
	releaseMaintainer(): void;
	isMaintained(): boolean;
	/** Run `work` holding the short-lived write mutex. */
	withWriteLock<T>(work: () => Promise<T>): Promise<T>;
}
