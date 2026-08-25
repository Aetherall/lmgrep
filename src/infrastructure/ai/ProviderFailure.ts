/**
 * Classifies provider errors that the research loop must handle differently
 * from a genuine failure.
 *
 * A timeout and a context overflow both mean "the loop cannot continue, but
 * what it gathered is still good" — they fall through to synthesis rather than
 * degrading the whole run.
 */
export class ProviderFailure {
	private static readonly OVERFLOW_PATTERN =
		/context (size|length|window)|exceed|too (long|large)|max.*token/i;

	static isAbort(error: unknown): boolean {
		return (
			error instanceof Error &&
			(error.name === "AbortError" || error.name === "TimeoutError")
		);
	}

	/** A provider 400 whose body mentions the context window being exceeded. */
	static isContextOverflow(error: unknown): boolean {
		const e = error as {
			statusCode?: number;
			responseBody?: string;
			message?: string;
		};
		if (e?.statusCode !== 400) return false;
		return ProviderFailure.OVERFLOW_PATTERN.test(
			`${e.responseBody ?? ""} ${e.message ?? ""}`,
		);
	}

	/** Opt-in diagnostics; provider errors carry detail worth seeing. */
	static debug(where: string, error: unknown): void {
		if (!process.env.LMGREP_DEBUG) return;
		const e = error as Record<string, unknown>;
		console.error(`[lmgrep debug] ${where} error:`, {
			name: e?.name,
			message: e?.message,
			statusCode: e?.statusCode,
			responseBody: e?.responseBody,
		});
	}
}
