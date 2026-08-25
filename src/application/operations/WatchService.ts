import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";
import type { LockPort } from "../../domain/ports/LockPort.js";
import type { LoggerPort } from "../../domain/ports/LoggerPort.js";
import type { WorkspacePort } from "../../domain/ports/WorkspacePort.js";
import type { IndexBuilder } from "../indexing/IndexBuilder.js";

/**
 * Keeps an index current while the process runs.
 *
 * Two mechanisms, because neither suffices alone: filesystem events give a
 * fast path for ordinary edits, and a periodic full reconcile is the backstop
 * for what recursive `fs.watch` misses on Linux — new subdirectories, editor
 * atomic saves, event bursts. The reconcile also retries files that failed
 * while the embedder was down, which is what removes the need to re-run
 * `lmgrep index` by hand.
 */
export class WatchService {
	/** How often the backstop reconcile runs. */
	private static readonly RECONCILE_MS = 30_000;
	/** Window for coalescing a burst of filesystem events. */
	private static readonly DEBOUNCE_MS = 2000;

	private indexing = false;
	/** Whether anything arrived while a run was in flight. */
	private queuedWork = false;
	/**
	 * Paths queued mid-run, or undefined when the queued work is a full
	 * rebuild. A full rebuild is a superset, so once one is queued no file list
	 * may narrow it back down.
	 */
	private queuedFiles: string[] | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private watcher: { close(): void } | undefined;

	private holdsLock = false;

	constructor(
		private readonly builder: IndexBuilder,
		private readonly workspace: WorkspacePort,
		private readonly config: LmgrepConfig,
		private readonly cwd: string,
		private readonly logger: LoggerPort,
		private readonly locks: LockPort,
	) {}

	/**
	 * Begin watching. Returns a function that stops it.
	 *
	 * Acquiring the maintainer lock is what makes exactly one process
	 * responsible for a database; it also registers this process so
	 * `lmgrep status` can report who is watching. Losing the race is normal —
	 * another server already has it — and simply means not watching.
	 */
	start(): () => void {
		if (!this.locks.acquireMaintainer()) {
			this.logger.info("Another process is already watching this index.");
			return () => {};
		}
		this.holdsLock = true;
		return this.beginWatching();
	}

	private beginWatching(): () => void {
		// Catch up first, so a branch checked out while this was not running
		// gets its manifest bootstrapped before any event arrives.
		void this.reindex();

		this.watcher = this.workspace.watch(
			this.cwd,
			this.config.ignore,
			(changed) => void this.reindex(changed),
			WatchService.DEBOUNCE_MS,
			this.config.extensions,
		);

		this.timer = setInterval(
			() => void this.reindex(),
			WatchService.RECONCILE_MS,
		);
		// Never keep the host process alive on the timer alone.
		this.timer.unref?.();

		this.logger.info("Watching for changes...");
		return () => this.stop();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.watcher?.close();
		this.watcher = undefined;
		if (this.holdsLock) {
			this.locks.releaseMaintainer();
			this.holdsLock = false;
		}
	}

	/**
	 * Run an index pass, coalescing anything that arrives while one is in
	 * flight. A queued full rebuild wins over queued file lists: it is the
	 * superset, and narrowing it would skip work.
	 */
	private async reindex(changedFiles?: string[]): Promise<void> {
		if (this.indexing) {
			this.enqueue(changedFiles);
			return;
		}

		this.indexing = true;
		try {
			this.logger.info(
				changedFiles?.length
					? `Changes detected in ${changedFiles.length} file(s), re-indexing...`
					: "Changes detected, re-indexing...",
			);
			await this.builder.build({ files: changedFiles });
		} catch (err) {
			this.logger.error(
				`Index error: ${err instanceof Error ? err.message : err}`,
			);
		} finally {
			this.indexing = false;
			if (this.queuedWork) {
				const next = this.queuedFiles;
				this.queuedWork = false;
				this.queuedFiles = undefined;
				void this.reindex(next);
			}
		}
	}

	/**
	 * Merge incoming work into whatever is already queued.
	 *
	 * The previous implementation used `undefined` both for "nothing queued"
	 * and for "a full rebuild is queued", so a reconcile that landed mid-run
	 * was silently dropped. The two states are now distinct.
	 */
	private enqueue(changedFiles?: string[]): void {
		if (!changedFiles) {
			this.queuedWork = true;
			this.queuedFiles = undefined;
			return;
		}
		// A queued full rebuild already covers these paths.
		if (this.queuedWork && this.queuedFiles === undefined) return;

		this.queuedWork = true;
		this.queuedFiles = [...(this.queuedFiles ?? []), ...changedFiles];
	}
}
