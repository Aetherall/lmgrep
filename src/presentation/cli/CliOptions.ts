import type { Command } from "commander";

/** The one option every command shares, and its help text. */
export class CliOptions {
	/**
	 * `--in` replaced three overlapping options — `--project`, `--across` and
	 * `--database` — which were three spellings of "somewhere other than here".
	 *
	 * A value with a separator is a project directory, because that is what
	 * people have to hand; a bare name is a standalone index kept in the state
	 * directory, for corpora that are not repositories.
	 */
	static readonly TARGET =
		"Project directory, or the name of a standalone index. " +
		"Repeat to search several at once; use `.` to include the current project.";

	static target(command: Command): Command {
		return command.option(
			"--in <project-or-name>",
			CliOptions.TARGET,
			CliOptions.collect,
			[] as string[],
		);
	}

	/** Commander calls this once per occurrence of a repeatable option. */
	private static collect(value: string, previous: string[]): string[] {
		return [...previous, value];
	}

	/** The single target a write command operates on, if any. */
	static single(targets: string[] | undefined): string | undefined {
		return targets && targets.length > 0 ? targets[0] : undefined;
	}
}
