/** A human-written duration like "10m" or "2h", as milliseconds. */
export class Duration {
	private static readonly UNIT_MS: Record<string, number> = {
		s: 1000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
	};

	private constructor(readonly milliseconds: number) {}

	static parse(value: string): Duration {
		const match = value.match(/^(\d+)\s*(s|m|h|d)$/);
		if (!match) {
			throw new Error(`Invalid duration "${value}". Use e.g. 10m, 2h, 1d`);
		}
		return new Duration(
			Number.parseInt(match[1], 10) * Duration.UNIT_MS[match[2]],
		);
	}

	/** The wall-clock instant this duration ago. */
	agoFrom(now: number): number {
		return now - this.milliseconds;
	}
}
