import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	FacetSession,
	type FacetSessionState,
} from "../../domain/faceting/FacetSession.js";
import type { SessionStorePort } from "../../domain/ports/SessionStorePort.js";
import type { StateDirectoryPort } from "../../domain/ports/StateDirectoryPort.js";
import type { ProjectId } from "../../domain/project/ProjectId.js";

/**
 * Facet sessions on disk, one JSON file per session, scoped per project.
 *
 * Sessions are disposable navigation state, not data: they are pruned by age
 * and count on every write, so an abandoned exploration cannot accumulate.
 */
export class FacetSessionStore implements SessionStorePort {
	private static readonly SUBDIR = "facet-sessions";
	/** Max sessions per project before the oldest are evicted on write. */
	private static readonly MAX_SESSIONS = 50;
	/** Sessions older than this are pruned on next access. */
	private static readonly TTL_MS = 24 * 60 * 60 * 1000;
	/** Excludes 0/1/l, which are easily confused when retyped. */
	private static readonly ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

	constructor(private readonly state: StateDirectoryPort) {}

	load(project: ProjectId, id: string): FacetSession | undefined {
		const path = this.sessionPath(project, id);
		if (!existsSync(path)) return undefined;
		try {
			return FacetSession.fromState(
				JSON.parse(readFileSync(path, "utf-8")) as FacetSessionState,
			);
		} catch {
			return undefined;
		}
	}

	save(project: ProjectId, session: FacetSession): void {
		const dir = this.sessionsDirectory(project);
		mkdirSync(dir, { recursive: true });
		this.prune(dir);
		writeFileSync(
			this.sessionPath(project, session.id),
			JSON.stringify(session.toState()),
		);
	}

	create(project: ProjectId, query: string, rootHits: string[]): FacetSession {
		const session = FacetSession.create(
			this.allocateId(this.listIds(project)),
			query,
			rootHits,
		);
		this.save(project, session);
		return session;
	}

	listIds(project: ProjectId): Set<string> {
		const dir = this.sessionsDirectory(project);
		if (!existsSync(dir)) return new Set();
		return new Set(
			readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.map((f) => f.slice(0, -".json".length)),
		);
	}

	private sessionsDirectory(project: ProjectId): string {
		return join(this.state.root(), project.toSlug(), FacetSessionStore.SUBDIR);
	}

	private sessionPath(project: ProjectId, id: string): string {
		return join(this.sessionsDirectory(project), `${id}.json`);
	}

	/** Short ids, growing only if the short space is genuinely crowded. */
	private allocateId(existing: Set<string>): string {
		for (let length = 3; length <= 5; length++) {
			for (let attempt = 0; attempt < 50; attempt++) {
				let id = "";
				for (let i = 0; i < length; i++) {
					id +=
						FacetSessionStore.ID_ALPHABET[
							Math.floor(Math.random() * FacetSessionStore.ID_ALPHABET.length)
						];
				}
				if (!existing.has(id)) return id;
			}
		}
		throw new Error("Could not allocate session id");
	}

	/** Drop expired sessions, then the oldest surviving ones over the cap. */
	private prune(dir: string): void {
		let entries: Array<{ name: string; mtimeMs: number }>;
		try {
			entries = readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.map((f) => ({ name: f, mtimeMs: statSync(join(dir, f)).mtimeMs }));
		} catch {
			return;
		}

		const now = Date.now();
		for (const e of entries) {
			if (now - e.mtimeMs > FacetSessionStore.TTL_MS) {
				this.remove(join(dir, e.name));
			}
		}

		const remaining = entries.filter(
			(e) => now - e.mtimeMs <= FacetSessionStore.TTL_MS,
		);
		if (remaining.length >= FacetSessionStore.MAX_SESSIONS) {
			remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
			const overflow = remaining.length - FacetSessionStore.MAX_SESSIONS + 1;
			for (let i = 0; i < overflow; i++) {
				this.remove(join(dir, remaining[i].name));
			}
		}
	}

	private remove(path: string): void {
		try {
			unlinkSync(path);
		} catch {}
	}
}
