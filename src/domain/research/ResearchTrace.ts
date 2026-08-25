/** One step of a research run, for the caller to display live. */
export type TraceEntry =
	| { kind: "search"; query: string; hits: number }
	| { kind: "note"; message: string };

/** Records what a research run did, and streams it to an optional observer. */
export class ResearchTrace {
	private readonly entries: TraceEntry[] = [];

	constructor(private readonly observer?: (entry: TraceEntry) => void) {}

	record(entry: TraceEntry): void {
		this.entries.push(entry);
		this.observer?.(entry);
	}

	searched(query: string, hits: number): void {
		this.record({ kind: "search", query, hits });
	}

	noted(message: string): void {
		this.record({ kind: "note", message });
	}

	toArray(): TraceEntry[] {
		return [...this.entries];
	}
}
