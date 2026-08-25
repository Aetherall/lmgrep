import { Command } from "commander";
import { CommandContext } from "./CommandContext.js";
import { AskCommand } from "./commands/AskCommand.js";
import { CompletionsCommand } from "./commands/CompletionsCommand.js";
import { ConfigCommands } from "./commands/ConfigCommands.js";
import { IndexCommand } from "./commands/IndexCommand.js";
import { MaintenanceCommands } from "./commands/MaintenanceCommands.js";
import { MigrateCommand } from "./commands/MigrateCommand.js";
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
 * Commands are objects that register themselves, so adding one is a single
 * entry in {@link commands} rather than another few hundred lines in one file.
 */
export class Cli {
	private readonly program = new Command();

	constructor(private readonly context = new CommandContext()) {
		this.program
			.name("lmgrep")
			.description("Semantic code search with any AI embedding provider")
			.version("0.1.0");

		for (const command of this.commands()) command.register(this.program);
	}

	async run(argv: string[] = process.argv): Promise<void> {
		// With no arguments and both streams piped, this was launched as an
		// MCP server over stdio rather than by a human at a terminal.
		if (Cli.looksLikeStdioLaunch(argv)) {
			await import("../../mcp.js");
			return;
		}

		try {
			await this.program.parseAsync(argv);
		} catch (err) {
			// Every failure reaching here is a user-facing condition — no
			// index, an unreachable provider, incompatible embeddings — not a
			// defect. Report the message and set an exit code; a stack trace
			// would only bury it. Guarding once here means no command can
			// forget to.
			this.context.fail(err);
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
			new IndexCommand(this.context),
			new SearchCommand(this.context),
			new AskCommand(this.context),
			new StatusCommand(this.context),
			new MaintenanceCommands(this.context),
			new ServerCommands(this.context),
			new ShareCommands(this.context),
			new ConfigCommands(this.context),
			new MigrateCommand(this.context),
			new CompletionsCommand(this.context),
		];
	}
}
