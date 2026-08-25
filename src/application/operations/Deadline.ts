/** Bounds how long an operation may take. */
export class Deadline {
	private constructor(private readonly milliseconds: number) {}

	static after(milliseconds: number): Deadline {
		return new Deadline(milliseconds);
	}

	/**
	 * Reject if `work` has not settled in time.
	 *
	 * The timer is always cleared, including on the happy path — an uncleared
	 * timer keeps the event loop alive and would stop a CLI process exiting.
	 */
	enforce<T>(work: Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`timeout after ${this.milliseconds}ms`)),
				this.milliseconds,
			);
			work.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
	}
}
