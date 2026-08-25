import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StateDirectoryPort } from "../../domain/ports/StateDirectoryPort.js";
import { TableName } from "../lancedb/LanceTables.js";

/** The sidecar record describing what an index contains and how it was built. */
export interface ProjectMetadata {
	root: string;
	remote?: string;
	branch: string;
	indexedAt: string;
	/** Full model string used at index time (e.g. "openai:nomic-embed-text"). */
	model?: string;
	/** Embedding vector dimensions. */
	dimensions?: number;
}

/** An index directory paired with the metadata found inside it. */
export interface DiscoveredProject {
	databasePath: string;
	metadata: ProjectMetadata;
}

/**
 * The `lmgrep.json` sidecar written beside each database.
 *
 * It records the model and dimensions the index was built with, which is what
 * lets a later search refuse to run against incompatible embeddings instead of
 * silently returning nonsense.
 */
export class ProjectMetadataStore {
	private static readonly FILE = "lmgrep.json";

	constructor(private readonly state: StateDirectoryPort) {}

	read(databasePath: string): ProjectMetadata | undefined {
		try {
			return JSON.parse(
				readFileSync(join(databasePath, ProjectMetadataStore.FILE), "utf-8"),
			) as ProjectMetadata;
		} catch {
			return undefined;
		}
	}

	/**
	 * Write the sidecar, preserving the model and dimensions already recorded.
	 *
	 * The first index establishes the baseline; later writes must not overwrite
	 * it, or a search with a different model would stop being detectable as a
	 * mismatch.
	 */
	write(
		databasePath: string,
		metadata: Omit<ProjectMetadata, "indexedAt">,
	): void {
		mkdirSync(databasePath, { recursive: true });
		const existing = this.read(databasePath);
		const merged: ProjectMetadata = {
			root: metadata.root,
			remote: metadata.remote,
			branch: metadata.branch,
			indexedAt: new Date().toISOString(),
			model: existing?.model ?? metadata.model,
			dimensions: existing?.dimensions ?? metadata.dimensions,
		};
		writeFileSync(
			join(databasePath, ProjectMetadataStore.FILE),
			JSON.stringify(merged, null, 2),
		);
	}

	/**
	 * Whether a directory holds an lmgrep database, or is an empty directory
	 * safe to treat as one.
	 *
	 * `--database <path>` lets a caller aim any directory at any command, so a
	 * destructive operation must confirm the target is ours before touching it
	 * — without this, `lmgrep prune --database .` would delete a working tree.
	 * An empty directory passes because that is what an interrupted index
	 * leaves behind, and removing it cannot lose data.
	 */
	isDatabaseDirectory(databasePath: string): boolean {
		let entries: string[];
		try {
			entries = readdirSync(databasePath);
		} catch {
			return false;
		}
		if (entries.length === 0) return true;

		const markers = new Set<string>([
			ProjectMetadataStore.FILE,
			`${TableName.Chunks}.lance`,
			`${TableName.Files}.lance`,
			`${TableName.Vocab}.lance`,
		]);
		return entries.some((e) => markers.has(e));
	}

	/** Every index in the state directory that carries readable metadata. */
	discoverAll(): DiscoveredProject[] {
		const out: DiscoveredProject[] = [];
		for (const databasePath of this.state.listDatabaseDirectories()) {
			const metadata = this.read(databasePath);
			if (metadata) out.push({ databasePath, metadata });
		}
		return out;
	}
}
