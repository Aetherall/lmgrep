import { Command } from "commander";
import { CommandContext } from "./CommandContext.js";
import { AskCommand } from "./commands/AskCommand.js";
import { CompletionsCommand } from "./commands/CompletionsCommand.js";
import { ConfigCommands } from "./commands/ConfigCommands.js";
import { IndexCommand } from "./commands/IndexCommand.js";
import { ProjectsCommand } from "./commands/ProjectsCommand.js";
import { SearchCommand } from "./commands/SearchCommand.js";
import { ServerCommands } from "./commands/ServerCommands.js";
import { ShareCommands } from "./commands/ShareCommands.js";
import { StatusCommand } from "./commands/StatusCommand.js";

/** Anything that can add itself to the commander program. */
interface Registrable {
	register(program: Command): void;
}

/**
 * Assembles and runs the command-line interface.
 *
 * Two things here are deliberate. A bare `lmgrep <words>` searches, because
 * searching is what lmgrep is for and it should not cost a subcommand. And the
 * help is grouped, because a flat list of a dozen commands says nothing about
 * which two anyone actually needs — the first group is the whole product, and
 * the rest is setup you do once.
 */
export class Cli {
	/** Help grouping, by command name. Order here is order in `--help`. */
	private static readonly GROUPS: ReadonlyArray<[string, readonly string[]]> = [
		["Searching:", ["search", "ask"]],
		["Your projects:", ["index", "status", "projects"]],
		["Setup:", ["init", "config", "mcp", "completions"]],
		["Other:", ["serve", "share", "import"]],
	];

	private readonly program = new Command();

	constructor(private readonly context = new CommandContext()) {
		this.program
			.name("lmgrep")
			.description("Semantic code search, powered by a local embedding model")
			.version("0.1.0")
			.showHelpAfterError()
			.addHelpText(
				"after",
				"\nA bare query searches:  lmgrep how are webhooks authenticated" +
					"\nFirst time here:        lmgrep init  →  lmgrep index",
			);

		for (const command of this.commands()) command.register(this.program);
		this.group();
	}

	async run(argv: string[] = process.argv): Promise<void> {
		// With no arguments and both streams piped, this was launched as an
		// MCP server over stdio rather than by a human at a terminal.
		if (Cli.looksLikeStdioLaunch(argv)) {
			await import("../../mcp.js");
			return;
		}

		try {
			await this.program.parseAsync(this.withImplicitSearch(argv));
		} catch (err) {
			// Every failure reaching here is a user-facing condition — no
			// index, an unreachable provider, incompatible embeddings — not a
			// defect. Report the message and set an exit code; a stack trace
			// would only bury it. Guarding once here means no command can
			// forget to.
			this.context.fail(err);
		}
	}

	/**
	 * Treat a leading word that is not a command as the start of a query.
	 *
	 * The ambiguity is real but small: `lmgrep status` is the command, not a
	 * search for the word "status". Anything of more than one word, and
	 * anything that is not a command name, searches — which covers every query
	 * a person would actually type.
	 */
	private withImplicitSearch(argv: string[]): string[] {
		const rest = argv.slice(2);
		const first = rest[0];
		if (!first || first.startsWith("-")) return argv;
		if (this.commandNames().has(first)) return argv;
		return [...argv.slice(0, 2), "search", ...rest];
	}

	private commandNames(): Set<string> {
		const names = new Set<string>(["help"]);
		for (const command of this.program.commands) {
			names.add(command.name());
			for (const alias of command.aliases()) names.add(alias);
		}
		return names;
	}

	private group(): void {
		const groupOf = new Map<string, string>();
		for (const [group, names] of Cli.GROUPS) {
			for (const name of names) groupOf.set(name, group);
		}
		for (const command of this.program.commands) {
			const group = groupOf.get(command.name());
			if (group) command.helpGroup(group);
		}
	}

	private static looksLikeStdioLaunch(argv: string[]): boolean {
		return (
			argv.slice(2).length === 0 &&
			!process.stdin.isTTY &&
			!process.stdout.isTTY
		);
	}

	private commands(): Registrable[] {
		return [
			new SearchCommand(this.context),
			new AskCommand(this.context),
			new IndexCommand(this.context),
			new StatusCommand(this.context),
			new ProjectsCommand(this.context),
			new ConfigCommands(this.context),
			new ServerCommands(this.context),
			new ShareCommands(this.context),
			new CompletionsCommand(this.context),
		];
	}
}
