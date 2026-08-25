import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StateDirectoryPort } from "../../domain/ports/StateDirectoryPort.js";

/**
 * StateDirectoryPort over the real filesystem, rooted at the XDG state
 * location. Existence probes swallow their errors: an unreadable or missing
 * path is simply "not a database", never a failure.
 */
export class StateDirectory implements StateDirectoryPort {
	private readonly base: string;

	constructor(base?: string) {
		this.base = base ?? join(homedir(), ".local", "state", "lmgrep");
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

	listDatabaseDirectories(): string[] {
		let entries: string[];
		try {
			entries = readdirSync(this.base);
		} catch {
			return [];
		}
		return entries
			.map((name) => join(this.base, name))
			.filter((p) => this.isDirectory(p));
	}
}
