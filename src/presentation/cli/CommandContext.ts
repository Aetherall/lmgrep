import { resolve } from "node:path";
import type { Lmgrep } from "../../application/Lmgrep.js";
import { LmgrepFactory } from "../../application/LmgrepFactory.js";
import { Renderer } from "./Renderer.js";

/** Options every command accepts. */
export interface GlobalOptions {
	/** Repeatable `--in` targets. Write commands use only the first. */
	in?: string[];
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
		const targets = CommandContext.targets(options);
		return this.factory.open({
			cwd: targets.cwd,
			database: targets.name,
			onWarning: (message) => this.renderer.error(message),
		});
	}

	/**
	 * Split `--in` values into the three things they can mean.
	 *
	 * The first path-like value replaces the working directory — "act as if I
	 * were there" — which is what makes `status --in ../other` and
	 * `search --in ../other` mean the obvious thing without a second flag. Any
	 * further paths are additional projects to search. A bare name selects a
	 * standalone index instead.
	 */
	static targets(options: GlobalOptions): {
		cwd: string;
		name?: string;
		across: string[];
	} {
		const values = options.in ?? [];
		const paths = values.filter((v) => CommandContext.isPathLike(v));
		const name = values.find((v) => !CommandContext.isPathLike(v));
		return {
			cwd: paths[0] ? resolve(process.cwd(), paths[0]) : process.cwd(),
			name,
			across: paths.slice(1),
		};
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
	 * no stack trace. Errors reaching here are user-facing conditions (no
	 * index, bad path, unreachable provider), not defects. Called once from
	 * {@link Cli.run} so no command can forget to.
	 */
	fail(error: unknown): void {
		this.renderer.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}

	static isPathLike(value: string): boolean {
		return (
			value.includes("/") ||
			value.includes("\\") ||
			value === "." ||
			value === ".."
		);
	}

	static integer(value: string | undefined, fallback: number): number {
		if (value === undefined) return fallback;
		const n = Number.parseInt(value, 10);
		return Number.isNaN(n) ? fallback : n;
	}

	/** Parse a comma-separated option into trimmed values. */
	static list(value?: string): string[] | undefined {
		if (!value) return undefined;
		return value.split(",").map((s) => s.trim());
	}
}
