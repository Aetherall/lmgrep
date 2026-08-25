import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";

export type HealthReason =
	| "ok"
	| "not_indexed"
	| "embedding_failed"
	| "search_empty";

export interface HealthState {
	healthy: boolean;
	reason: HealthReason;
}

/** What the monitor needs to probe, without knowing how any of it works. */
export interface HealthProbe {
	isIndexed(): boolean;
	/** Full status check; throws when the embedder is unreachable. */
	inspect(): Promise<{
		fileCount: number;
		embeddingOk: boolean;
		searchOk: boolean;
	}>;
	/** Ensure the file watcher is running, if this process can hold the lock. */
	ensureWatching(): void;
}

/**
 * Tracks whether search is usable, and tells listeners when that changes.
 *
 * The polling policy matters more than it looks. While healthy the monitor
 * never pings the embedder at all: a local model should be free to unload and
 * sleep, and a billed remote provider should not be charged for liveness
 * checks. Polling arms only when a real search has failed, and disarms the
 * moment one succeeds — so the cost is paid exactly when something is wrong.
 */
export class HealthMonitor {
	private state: HealthState;
	private readonly listeners = new Set<(state: HealthState) => void>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private polling = false;
	private delayMs = 0;
	private disposed = false;

	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;

	constructor(
		private readonly probe: HealthProbe,
		config: LmgrepConfig,
	) {
		// A local embedder is free to poll often; a billed one is not.
		this.baseDelayMs = config.local ? 10_000 : 60_000;
		// Cap the backoff so a long-down provider is not pinged every base
		// period for hours: ~2min local, ~5min remote.
		this.maxDelayMs = config.local ? 120_000 : 300_000;

		this.state = probe.isIndexed()
			? { healthy: true, reason: "ok" }
			: { healthy: false, reason: "not_indexed" };
	}

	get current(): HealthState {
		return this.state;
	}

	onChange(listener: (state: HealthState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Boot: start watching, but do not poll. The initial optimistic state
	 * already drives an accurate tool description, and the embedder stays
	 * asleep until something actually needs it.
	 */
	start(): void {
		this.probe.ensureWatching();
	}

	/** A completed search proves the embedder and index are both live. */
	markHealthy(): void {
		this.transition({ healthy: true, reason: "ok" });
		this.probe.ensureWatching();
		this.stopPolling();
	}

	/** A failed search may mean the embedder is down; watch for recovery. */
	markFailed(): void {
		this.startPolling();
	}

	dispose(): void {
		this.disposed = true;
		this.stopPolling();
		this.listeners.clear();
	}

	private async check(): Promise<HealthState> {
		if (!this.probe.isIndexed()) {
			return { healthy: false, reason: "not_indexed" };
		}
		try {
			const info = await this.probe.inspect();
			if (info.fileCount === 0) {
				return { healthy: false, reason: "not_indexed" };
			}
			if (!info.embeddingOk) {
				return { healthy: false, reason: "embedding_failed" };
			}
			if (!info.searchOk) {
				return { healthy: false, reason: "search_empty" };
			}
			return { healthy: true, reason: "ok" };
		} catch {
			return { healthy: false, reason: "embedding_failed" };
		}
	}

	private async refresh(): Promise<void> {
		if (this.disposed) return;
		this.transition(await this.check());

		if (this.state.healthy) {
			// Recovered — stop pinging so the embedder can sleep again. The
			// loop re-arms on the next failed search.
			this.probe.ensureWatching();
			this.stopPolling();
		}
	}

	private transition(next: HealthState): void {
		if (
			next.healthy === this.state.healthy &&
			next.reason === this.state.reason
		) {
			return;
		}
		this.state = next;
		for (const listener of this.listeners) listener(next);
	}

	private startPolling(): void {
		if (this.polling || this.disposed) return;
		this.polling = true;
		this.delayMs = this.baseDelayMs;
		this.probe.ensureWatching();
		void this.poll();
	}

	private async poll(): Promise<void> {
		if (!this.polling || this.disposed) return;
		await this.refresh();
		// refresh() disarms polling if the embedder recovered.
		if (!this.polling || this.disposed) return;

		this.timer = setTimeout(() => void this.poll(), this.delayMs);
		this.timer.unref?.();
		this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs);
	}

	private stopPolling(): void {
		this.polling = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
