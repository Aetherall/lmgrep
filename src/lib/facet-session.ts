import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSlug } from "./store.js";

export interface FacetNode {
	/** "/"-joined labels from root, empty for the root node */
	path: string;
	/** Chunk ids in this pool (ordered by initial retrieval score) */
	hits: string[];
	/** Children produced by a facet computation; absent until refined */
	children?: Array<{
		label: string;
		size: number;
		hits: string[];
		/** Top vocab candidates for this cluster's axis (label first). */
		candidates?: string[];
		/** Deduped pairwise qualifiers for compact display. */
		qualifiers?: string[];
		/** Pairwise discriminators against each sibling cluster. */
		disambiguators?: Array<{ vs: string; terms: string[] }>;
	}>;
}

export interface FacetSession {
	id: string;
	query: string;
	createdAt: number;
	/** Map from path ("", "token", "token/access") → node */
	nodes: Record<string, FacetNode>;
}

const SESSIONS_SUBDIR = "facet-sessions";
/** Max sessions per project before we LRU-evict the oldest on write. */
const MAX_SESSIONS = 50;
/** Sessions older than this are pruned on next access. */
const TTL_MS = 24 * 60 * 60 * 1000;

function sessionsDir(projectRoot: string): string {
	return join(
		homedir(),
		".local",
		"state",
		"lmgrep",
		buildSlug(projectRoot),
		SESSIONS_SUBDIR,
	);
}

function sessionPath(projectRoot: string, id: string): string {
	return join(sessionsDir(projectRoot), `${id}.json`);
}

const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789"; // no 0/1/l confusables

export function generateSessionId(existing: Set<string>): string {
	for (let len = 3; len <= 5; len++) {
		for (let attempt = 0; attempt < 50; attempt++) {
			let id = "";
			for (let i = 0; i < len; i++) {
				id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
			}
			if (!existing.has(id)) return id;
		}
	}
	throw new Error("Could not allocate session id");
}

export function listSessions(projectRoot: string): string[] {
	const dir = sessionsDir(projectRoot);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.slice(0, -5));
}

export function loadSession(
	projectRoot: string,
	id: string,
): FacetSession | undefined {
	const p = sessionPath(projectRoot, id);
	if (!existsSync(p)) return undefined;
	try {
		return JSON.parse(readFileSync(p, "utf-8")) as FacetSession;
	} catch {
		return undefined;
	}
}

export function saveSession(
	projectRoot: string,
	session: FacetSession,
): void {
	const dir = sessionsDir(projectRoot);
	mkdirSync(dir, { recursive: true });
	pruneOld(dir);
	writeFileSync(sessionPath(projectRoot, session.id), JSON.stringify(session));
}

function pruneOld(dir: string): void {
	let entries: Array<{ name: string; mtimeMs: number }>;
	try {
		entries = readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => ({
				name: f,
				mtimeMs: statSync(join(dir, f)).mtimeMs,
			}));
	} catch {
		return;
	}

	const now = Date.now();
	// TTL prune
	for (const e of entries) {
		if (now - e.mtimeMs > TTL_MS) {
			try {
				unlinkSync(join(dir, e.name));
			} catch {}
		}
	}

	// LRU prune
	const remaining = entries.filter((e) => now - e.mtimeMs <= TTL_MS);
	if (remaining.length >= MAX_SESSIONS) {
		remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
		const overflow = remaining.length - MAX_SESSIONS + 1;
		for (let i = 0; i < overflow; i++) {
			try {
				unlinkSync(join(dir, remaining[i].name));
			} catch {}
		}
	}
}

export function createSession(
	projectRoot: string,
	query: string,
	rootHits: string[],
): FacetSession {
	const existing = new Set(listSessions(projectRoot));
	const id = generateSessionId(existing);
	const session: FacetSession = {
		id,
		query,
		createdAt: Date.now(),
		nodes: {
			"": { path: "", hits: rootHits },
		},
	};
	saveSession(projectRoot, session);
	return session;
}

/**
 * Parse a path like "kx3" or "kx3/token/access" into { id, segments }.
 * Returns undefined if malformed.
 */
export function parseFacetPath(
	input: string,
): { id: string; segments: string[] } | undefined {
	const parts = input.split("/").filter(Boolean);
	if (parts.length === 0) return undefined;
	const id = parts[0];
	if (!/^[a-z2-9]+$/.test(id)) return undefined;
	return { id, segments: parts.slice(1) };
}

export function nodeKey(segments: string[]): string {
	return segments.join("/");
}

/** All ancestor labels along a path — used to prevent label collisions in refinement. */
export function ancestorLabels(segments: string[]): string[] {
	return [...segments];
}
