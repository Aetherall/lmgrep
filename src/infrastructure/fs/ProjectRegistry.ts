import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	ProjectRegistryPort,
	RegisteredIndex,
} from "../../domain/ports/ProjectRegistryPort.js";
import type { StateDirectoryPort } from "../../domain/ports/StateDirectoryPort.js";

/**
 * ProjectRegistryPort as one small JSON file per database.
 *
 * One file per entry rather than one file listing all of them, because several
 * lmgrep processes index different projects at the same time — a shared list
 * would need a lock and would still lose writes if one crashed mid-rewrite.
 * Separate files make every write independent and every partial write
 * survivable: a corrupt entry is skipped, not fatal to the listing.
 */
export class ProjectRegistry implements ProjectRegistryPort {
	private static readonly SUFFIX = ".json";
	private static readonly KEY_LENGTH = 16;

	constructor(private readonly state: StateDirectoryPort) {}

	record(entry: Omit<RegisteredIndex, "indexedAt">): void {
		const directory = this.state.registryDirectory();
		mkdirSync(directory, { recursive: true });
		const full: RegisteredIndex = {
			...entry,
			indexedAt: new Date().toISOString(),
		};
		writeFileSync(
			this.pathFor(entry.databasePath),
			JSON.stringify(full, null, 2),
		);
	}

	list(): RegisteredIndex[] {
		return this.all().filter((e) => this.exists(e.databasePath));
	}

	dangling(): RegisteredIndex[] {
		return this.all().filter((e) => !this.exists(e.databasePath));
	}

	forget(databasePath: string): void {
		try {
			unlinkSync(this.pathFor(databasePath));
		} catch {}
	}

	private all(): RegisteredIndex[] {
		let names: string[];
		try {
			names = readdirSync(this.state.registryDirectory());
		} catch {
			return [];
		}

		const out: RegisteredIndex[] = [];
		for (const name of names) {
			if (!name.endsWith(ProjectRegistry.SUFFIX)) continue;
			try {
				const parsed = JSON.parse(
					readFileSync(join(this.state.registryDirectory(), name), "utf-8"),
				) as Partial<RegisteredIndex>;
				if (typeof parsed.databasePath === "string" && parsed.databasePath) {
					out.push(parsed as RegisteredIndex);
				}
			} catch {
				// A truncated or hand-edited entry is a lost pointer, never a
				// reason to fail the listing that would have shown the rest.
			}
		}
		return out;
	}

	private exists(databasePath: string): boolean {
		try {
			return statSync(databasePath).isDirectory();
		} catch {
			return false;
		}
	}

	/** Keyed by database path, so re-indexing refreshes rather than duplicates. */
	private pathFor(databasePath: string): string {
		const key = createHash("sha256")
			.update(databasePath)
			.digest("hex")
			.slice(0, ProjectRegistry.KEY_LENGTH);
		return join(
			this.state.registryDirectory(),
			`${key}${ProjectRegistry.SUFFIX}`,
		);
	}
}
