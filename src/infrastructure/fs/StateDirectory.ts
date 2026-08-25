import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StateDirectoryPort } from "../../domain/ports/StateDirectoryPort.js";

/**
 * StateDirectoryPort over the real filesystem, rooted at the XDG state
 * location.
 *
 * The subdirectories are new; earlier versions wrote databases and their lock
 * files as immediate children of the root, interleaved. {@link RESERVED} is
 * what keeps the two schemes apart, so a legacy scan never mistakes the
 * registry for a database.
 *
 * Existence probes swallow their errors: an unreadable or missing path is
 * simply "not a database", never a failure.
 */
export class StateDirectory implements StateDirectoryPort {
	private static readonly LOCKS = "locks";
	private static readonly REGISTRY = "registry";
	private static readonly DATABASES = "db";
	/** Subdirectories of the state root that are not legacy databases. */
	private static readonly RESERVED = new Set<string>([
		StateDirectory.LOCKS,
		StateDirectory.REGISTRY,
		StateDirectory.DATABASES,
	]);

	private readonly base: string;

	constructor(base?: string) {
		// LMGREP_STATE_DIR relocates everything machine-global in one step,
		// which is what makes an isolated run possible without also moving
		// HOME — moving HOME breaks provider resolution, since AI SDK packages
		// are found through the user's global node_modules.
		this.base =
			base ??
			process.env.LMGREP_STATE_DIR ??
			join(homedir(), ".local", "state", "lmgrep");
	}

	root(): string {
		return this.base;
	}

	isDirectory(path: string): boolean {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	}

	locksDirectory(): string {
		return join(this.base, StateDirectory.LOCKS);
	}

	registryDirectory(): string {
		return join(this.base, StateDirectory.REGISTRY);
	}

	databasesDirectory(): string {
		return join(this.base, StateDirectory.DATABASES);
	}

	legacyDatabaseDirectories(): string[] {
		let entries: string[];
		try {
			entries = readdirSync(this.base);
		} catch {
			return [];
		}
		return entries
			.filter((name) => !StateDirectory.RESERVED.has(name))
			.map((name) => join(this.base, name))
			.filter((p) => this.isDirectory(p));
	}
}
