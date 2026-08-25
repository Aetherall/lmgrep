/**
 * Tuning for the LanceDB vector index. The numbers here were measured on a
 * 43k-chunk / 3584-dimension index; the comments record what they bought so a
 * later change can tell a tuned value from an arbitrary one.
 */
export const VectorIndexPolicy = {
	/**
	 * Below this row count a brute-force scan is cheap enough that training an
	 * index costs more than it saves, and IVF-PQ has too few vectors to cluster
	 * well.
	 */
	MIN_ROWS_FOR_ANN: 5_000,

	/**
	 * Re-absorb new rows into the index once the unindexed tail passes this
	 * share of the indexed body. Rows outside the index are searched by flat
	 * scan, so the tail is exactly what needs bounding.
	 */
	UNINDEXED_REINDEX_RATIO: 0.2,

	/** ...but always tolerate a small tail, so a 3-chunk edit never retrains. */
	UNINDEXED_REINDEX_FLOOR: 2_000,

	/**
	 * Vector searches run without an explicit distance type, which LanceDB
	 * resolves to L2. The index has its own default, so it is pinned: an index
	 * built on a different metric would silently reorder every result.
	 */
	DISTANCE_TYPE: "l2",

	/**
	 * IVF-PQ stores compressed vectors, so its raw distances approximate the
	 * real ones. `refineFactor` makes LanceDB pull the uncompressed vectors for
	 * the top `limit * factor` candidates and re-score them exactly.
	 *
	 * It is not optional. Measured mean recall@20 against an exact scan:
	 *
	 *   off -> 53%   1 -> 75%   3 -> 86%   10 -> 91%   20 -> 94%   50 -> 94%
	 *
	 * and without it `_distance` is wrong by ~0.07, which matters because score
	 * is derived from it and users filter on `--min-score`. With refinement the
	 * scores match an exact scan to the digit.
	 *
	 * 20 sits at the knee: ~94% recall at ~11ms/query versus ~115ms for an
	 * exact scan. Beyond it recall flattens (the probed partitions run out of
	 * candidates) while latency keeps climbing. The refined set is bounded by
	 * the query limit, not by table size, so this costs a fixed few MB.
	 *
	 * Harmless on tables with no index: a flat scan already computes exact
	 * distances and returns identical rows.
	 */
	REFINE_FACTOR: 20,
} as const;

/**
 * Columns a search reads off a result row.
 *
 * Selecting explicitly keeps the embedding out of the result set — without it
 * LanceDB ships every over-fetched row's full vector back into JS for nothing.
 *
 * `_distance` is listed on purpose: LanceDB currently auto-projects it into any
 * scoring query but warns that it will stop, so naming it pins the behaviour
 * rather than relying on a deprecated default.
 */
export const SEARCH_COLUMNS = [
	"id",
	"filePath",
	"startLine",
	"endLine",
	"type",
	"name",
	"content",
	"context",
	"fileHash",
	"_distance",
] as const;
