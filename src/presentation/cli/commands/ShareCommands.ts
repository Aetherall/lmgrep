import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { Branch } from "../../../domain/project/Branch.js";
import type { IndexMetadata } from "../../../domain/project/IndexMetadata.js";
import { ModelIdentity } from "../../../domain/project/ModelIdentity.js";
import { ProjectLocator } from "../../../domain/project/ProjectLocator.js";
import { ProjectMetadataStore } from "../../../infrastructure/fs/ProjectMetadataStore.js";
import { StateDirectory } from "../../../infrastructure/fs/StateDirectory.js";
import { GitClient } from "../../../infrastructure/git/GitClient.js";
import { DatabaseImporter } from "../../../infrastructure/lancedb/DatabaseImporter.js";
import { LanceTables } from "../../../infrastructure/lancedb/LanceTables.js";
import { RowReplication } from "../../../infrastructure/lancedb/RowReplication.js";
import { IndexShare } from "../../../infrastructure/p2p/IndexShare.js";
import { ShareCode } from "../../../infrastructure/p2p/ShareCode.js";
import type { CommandContext } from "../CommandContext.js";

/** Everything a share operation needs about the local database. */
interface ShareTarget {
	locator: ProjectLocator;
	branch: Branch;
	location: string;
	metadata: IndexMetadata | undefined;
	store: ProjectMetadataStore;
}

/**
 * `export` and `import` — moving an index between machines or databases.
 *
 * Both exist to avoid re-embedding, which is the expensive part of indexing.
 * `import` accepts either a peer share code or a local database path, since
 * "get this index from somewhere else" is one intent to the user.
 */
export class ShareCommands {
	constructor(private readonly context: CommandContext) {}

	register(program: Command): void {
		this.registerExport(program);
		this.registerImport(program);
	}

	private registerExport(program: Command): void {
		program
			.command("export")
			.description("Share this project's index with a peer via P2P")
			.action(() => this.runExport());
	}

	private async runExport(): Promise<void> {
		const { renderer } = this.context;
		const { branch, location, metadata } = this.resolve();
		const tables = new LanceTables(location, branch);
		const share = new IndexShare(new RowReplication(tables, branch));

		const { code, done } = await share.send(metadata, {
			onProgress: (sent, total) =>
				process.stderr.write(`\rSending: ${sent}/${total} chunks`),
		});

		renderer.line(`Share code: ${code}`);
		renderer.line("Waiting for peer... (Ctrl+C to cancel)\n");
		await done;
		process.stderr.write("\n");
		renderer.line("Transfer complete.");
		tables.close();
	}

	private registerImport(program: Command): void {
		program
			.command("import [source]")
			.description(
				"Import chunks from a peer (share code) or another lmgrep database (path). " +
					"If no argument is given, tries to find a legacy index for this directory.",
			)
			.option("--reset", "Reset the current index before importing")
			.action((source: string | undefined, options: { reset?: boolean }) =>
				this.runImport(source, options),
			);
	}

	private async runImport(
		source: string | undefined,
		options: { reset?: boolean },
	): Promise<void> {
		if (source && ShareCode.looksLikeCode(source)) {
			await this.importFromPeer(source, options);
			return;
		}
		await this.importFromDatabase(source, options);
	}

	private async importFromPeer(
		source: string,
		options: { reset?: boolean },
	): Promise<void> {
		const { renderer } = this.context;
		const code = ShareCode.parse(source);
		if (!code) throw new Error(`Not a valid share code: ${source}`);

		renderer.line("Connecting to peer...");
		const lmgrep = await this.context.open({});
		if (options.reset) await lmgrep.maintenance.reset();
		const { branch, location, metadata } = this.resolve();
		await lmgrep.close();

		const tables = new LanceTables(location, branch);
		const share = new IndexShare(new RowReplication(tables, branch));

		const result = await share.receive(code, metadata, {
			onProgress: (received, total) =>
				process.stderr.write(`\rReceiving: ${received}/${total} chunks`),
			onMeta: (meta) =>
				renderer.line(
					`Peer index: ${meta.chunkCount} chunks` +
						(meta.model ? `, model: ${meta.model}` : "") +
						(meta.dimensions ? `, ${meta.dimensions} dims` : ""),
				),
			onWarning: (message) => renderer.error(message),
		});
		process.stderr.write("\n");
		renderer.line(
			`Imported ${result.chunks} chunks and ${result.files} file hashes from peer.`,
		);
		tables.close();
	}

	private async importFromDatabase(
		source: string | undefined,
		options: { reset?: boolean },
	): Promise<void> {
		const { renderer } = this.context;
		const cwd = this.context.cwd;
		const { locator, branch, location, store } = this.resolve();

		const sourcePath = source
			? resolve(cwd, source)
			: this.findLegacyIndex(locator, cwd);

		if (!existsSync(sourcePath)) {
			throw new Error(`Database not found: ${sourcePath}`);
		}
		if (resolve(sourcePath) === resolve(location)) {
			throw new Error("Source and destination are the same database.");
		}

		const lmgrep = await this.context.open({});
		if (options.reset) await lmgrep.maintenance.reset();
		await lmgrep.close();

		const tables = new LanceTables(location, branch);
		const { chunks, files } = await new DatabaseImporter(
			tables,
			branch,
		).importFrom(sourcePath);
		tables.close();

		renderer.line(
			`Imported ${chunks} chunks and ${files} file hashes from ${sourcePath}`,
		);

		// The source's model is what these vectors mean; without a matching
		// local model the import is unusable, so say so explicitly.
		const sourceMeta = store.read(sourcePath);
		if (sourceMeta?.model) {
			const family = ModelIdentity.of(sourceMeta.model).family;
			renderer.line(
				`\nThis index was built with "${sourceMeta.model}" (${family}` +
					`${sourceMeta.dimensions ? `, ${sourceMeta.dimensions} dims` : ""}).`,
			);
			renderer.line(
				"Configure a compatible model in .lmgrep.yml, then run `lmgrep init` to auto-detect.",
			);
		}
	}

	private findLegacyIndex(locator: ProjectLocator, cwd: string): string {
		const legacy = locator.legacyDatabasePathFor(cwd);
		if (!existsSync(legacy)) {
			throw new Error(
				"No legacy index found. Provide a path: lmgrep import <db-path>",
			);
		}
		this.context.renderer.line(`Found legacy index at ${legacy}`);
		return legacy;
	}

	/** The pieces every share operation needs, resolved from the cwd. */
	private resolve(): ShareTarget {
		const state = new StateDirectory();
		const locator = new ProjectLocator(new GitClient(), state);
		const store = new ProjectMetadataStore(state);
		const database = locator.resolveDatabase(this.context.cwd);
		return {
			locator,
			branch: database.branch,
			location: database.path,
			metadata: store.read(database.path),
			store,
		};
	}
}
