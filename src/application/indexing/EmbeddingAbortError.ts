/**
 * Raised when too many consecutive batches fail — the provider is down rather
 * than the input being bad. Successes are already persisted by the time this
 * throws, so the caller's job is to report and exit, not to roll back.
 */
export class EmbeddingAbortError extends Error {
	constructor(
		readonly succeeded: number,
		readonly failedIndices: Set<number>,
		readonly total: number,
	) {
		super(
			`Embedding aborted after ${failedIndices.size} failures. ` +
				`${succeeded}/${total} chunks embedded successfully. ` +
				"Check your embedding provider and run `lmgrep index` to resume.",
		);
		this.name = "EmbeddingAbortError";
	}
}
