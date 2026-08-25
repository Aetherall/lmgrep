import type { Lmgrep } from "../../application/Lmgrep.js";

/**
 * Owns the file watcher's lifecycle for a long-running server.
 *
 * Starting is idempotent and conditional: only one process can hold a
 * database's maintainer lock, so a second server on the same project simply
 * never starts watching rather than failing.
 */
export class IndexWatchController {
	private stop: (() => void) | undefined;
	private disposed = false;

	constructor(
		private readonly lmgrep: Lmgrep,
		private readonly isIndexed: () => boolean,
	) {}

	ensureStarted(): void {
		if (this.stop || this.disposed) return;
		// Nothing to watch until the project has an index.
		if (!this.isIndexed()) return;
		this.stop = this.lmgrep.watch();
	}

	release(): void {
		this.disposed = true;
		this.stop?.();
		this.stop = undefined;
	}
}
