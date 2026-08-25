/** What a maintenance pass did to one table. */
export interface TableOptimizeReport {
	table: string;
	rows: number;
	/**
	 * `skipped-small` - below the ANN threshold, flat scan is fine.
	 * `needs-index`   - big enough to want an index, but training was not
	 *                   requested on this path. Searches stay on flat scan
	 *                   until `lmgrep index` or `lmgrep compact` runs.
	 * `created`       - trained a vector index for the first time.
	 * `optimized`     - compacted and absorbed the unindexed tail.
	 * `up-to-date`    - tail still within tolerance, nothing done.
	 */
	action:
		| "skipped-small"
		| "needs-index"
		| "created"
		| "optimized"
		| "up-to-date";
	unindexed?: number;
}

export interface OptimizeReport {
	tables: TableOptimizeReport[];
}

export interface DedupeReport {
	before: number;
	after: number;
	duplicateIds: number;
	staleVersions: number;
}

export interface OptimizeOptions {
	/** Ignore the unindexed-tail tolerance and optimize regardless. */
	force?: boolean;
	/**
	 * Permit training an index where none exists. Off by default: training
	 * reads every vector and peaks at several GB, which must not happen behind
	 * a background watcher.
	 */
	create?: boolean;
}

/** Index upkeep: compaction, ANN index training, and duplicate removal. */
export interface IndexMaintenancePort {
	optimize(options?: OptimizeOptions): Promise<OptimizeReport>;
	/** Full unconditional pass, including the non-vector tables. */
	compact(): Promise<OptimizeReport>;
	/** Drop duplicate and stale-version rows, rewriting the table. */
	dedupe(): Promise<DedupeReport>;
	/** Delete every table — a full rebuild from scratch. */
	reset(): Promise<void>;
}
