import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import type { CommandContext } from "../CommandContext.js";

/** `lmgrep completions` — shell completion scripts. */
export class CompletionsCommand {
	/** Preferred first: a user-local path needs no privileges. */
	private static readonly ZSH_CANDIDATES = [
		join(homedir(), ".local", "share", "zsh", "site-functions"),
		"/usr/local/share/zsh/site-functions",
		"/usr/share/zsh/site-functions",
	];

	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		const completions = program
			.command("completions")
			.description("Output shell completions");

		completions
			.command("zsh")
			.description("Output zsh completions")
			.option("--install", "Install to site-functions and reload completions")
			.action((options: { install?: boolean }) => this.runZsh(options));
	}

	private runZsh(options: { install?: boolean }): void {
		const { renderer } = this.context;
		// Resolved relative to the built script, since the package ships the
		// completions directory alongside dist/.
		const script = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				"..",
				"..",
				"completions",
				"_lmgrep",
			),
			"utf-8",
		);

		if (!options.install) {
			renderer.line(script);
			return;
		}

		const target = this.findSiteFunctions();
		if (!target) {
			renderer.error(
				"Could not find a writable zsh site-functions directory.\n" +
					"Output manually with: lmgrep completions zsh > /path/to/_lmgrep",
			);
			process.exitCode = 1;
			return;
		}

		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "_lmgrep"), script);
		renderer.line(`Installed completions to ${join(target, "_lmgrep")}`);
		renderer.line("Restart your shell or run: exec zsh");
	}

	/**
	 * The first candidate directory that exists and is writable, or that we can
	 * create. `$fpath` is consulted too, since a user's zsh setup may put
	 * site-functions somewhere unusual.
	 */
	private findSiteFunctions(): string | undefined {
		const candidates = [...CompletionsCommand.ZSH_CANDIDATES];
		for (const entry of this.fpathEntries()) {
			if (entry.includes("site-functions") && !candidates.includes(entry)) {
				candidates.push(entry);
			}
		}

		for (const candidate of candidates) {
			try {
				if (existsSync(candidate)) {
					// Probe rather than trust: an existing directory may be
					// root-owned.
					const probe = join(candidate, ".lmgrep-test");
					writeFileSync(probe, "");
					rmSync(probe);
					return candidate;
				}
				if (existsSync(join(candidate, ".."))) {
					mkdirSync(candidate, { recursive: true });
					return candidate;
				}
			} catch {
				// Not writable — try the next candidate.
			}
		}
		return undefined;
	}

	private fpathEntries(): string[] {
		try {
			return execSync("zsh -c 'echo $fpath'", {
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 3000,
			})
				.toString()
				.trim()
				.split(" ");
		} catch {
			return [];
		}
	}
}
