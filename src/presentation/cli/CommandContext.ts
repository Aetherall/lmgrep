import type { Lmgrep } from "../../application/Lmgrep.js";
import { LmgrepFactory } from "../../application/LmgrepFactory.js";
import { Renderer } from "./Renderer.js";

/** Options every command accepts. */
export interface GlobalOptions {
	database?: string;
}

/**
 * Shared plumbing for CLI commands: opening an Lmgrep, closing it again, and
 * turning a thrown error into an exit code.
 *
 * Commands run through {@link withLmgrep} rather than opening their own, so no
 * command can forget to close the database — a leaked LanceDB connection keeps
 * a native runtime and its buffers alive for the life of the process.
 */
export class CommandContext {
	constructor(
		readonly renderer: Renderer = new Renderer(),
		private readonly factory: LmgrepFactory = new LmgrepFactory(),
	) {}

	get cwd(): string {
		return process.cwd();
	}

	async open(options: GlobalOptions): Promise<Lmgrep> {
		return this.factory.open({
			cwd: this.cwd,
			database: options.database,
		});
	}

	/** Open, run, and always close — even when `run` throws. */
	async withLmgrep<T>(
		options: GlobalOptions,
		run: (lmgrep: Lmgrep) => Promise<T>,
	): Promise<T | undefined> {
		const lmgrep = await this.open(options);
		try {
			return await run(lmgrep);
		} finally {
			await lmgrep.close();
		}
	}

	/**
	 * Report a failure the way a CLI should: message on stderr, non-zero exit,
	 * no stack trace. Errors here are user-facing conditions (no index, bad
	 * path, unreachable provider), not defects.
	 */
	fail(error: unknown): void {
		this.renderer.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}

	/** Run `body`, converting a thrown error into a reported failure. */
	async guarded(body: () => Promise<void>): Promise<void> {
		try {
			await body();
		} catch (err) {
			this.fail(err);
		}
	}

	/** Parse a comma-separated option into trimmed values. */
	static list(value?: string): string[] | undefined {
		if (!value) return undefined;
		return value.split(",").map((s) => s.trim());
	}

	static integer(value: string | undefined, fallback: number): number {
		if (value === undefined) return fallback;
		const n = Number.parseInt(value, 10);
		return Number.isNaN(n) ? fallback : n;
	}

	static float(value?: string): number | undefined {
		if (value === undefined) return undefined;
		const n = Number.parseFloat(value);
		return Number.isNaN(n) ? undefined : n;
	}
}
