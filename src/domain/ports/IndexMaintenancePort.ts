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
	 * `dropped`       - a table no longer part of the schema was removed.
	 */
	action:
		| "skipped-small"
		| "needs-index"
		| "created"
		| "optimized"
		| "up-to-date"
		| "dropped";
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

/** What pruning reclaimed from one table. */
export interface TablePruneReport {
	table: string;
	oldVersionsRemoved: number;
	bytesRemoved: number;
	fragmentsRemoved: number;
}

export interface PruneReport {
	tables: TablePruneReport[];
}

/** Whether searches are answered by a vector index or a brute-force scan. */
export interface VectorIndexState {
	rows: number;
	/** True when a vector index exists for the chunk table. */
	built: boolean;
	/** Rows appended since the index was last refreshed; these are scanned. */
	unindexed: number;
	/** False when the table is too small for an index to be worth training. */
	worthBuilding: boolean;
}

/** Index upkeep: compaction, ANN index training, and duplicate removal. */
export interface IndexMaintenancePort {
	optimize(options?: OptimizeOptions): Promise<OptimizeReport>;
	/** Full unconditional pass, including the non-vector tables. */
	compact(): Promise<OptimizeReport>;
	/**
	 * Compact every table and delete versions old enough that no reader can
	 * still be on them. Every write leaves a version and a fragment behind;
	 * without this they accumulate for the life of the index.
	 */
	prune(): Promise<PruneReport>;
	/** Drop duplicate and stale-version rows, rewriting the table. */
	dedupe(): Promise<DedupeReport>;
	/** Delete every table — a full rebuild from scratch. */
	reset(): Promise<void>;
	/** How searches are currently answered. */
	vectorIndexState(): Promise<VectorIndexState>;
}
