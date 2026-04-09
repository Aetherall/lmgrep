#!/usr/bin/env node
process.title = "lmgrep";

import { Command } from "commander";
import { createHash } from "node:crypto";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	rmSync,
	mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { createIndex } from "./index.js";
import { getGlobalConfigPath } from "./lib/config.js";
import { walkFiles } from "./lib/scanner.js";
import {
	Store,
	getDbPath,
	getLegacyDbPath,
	isDbLocked,
	readProjectMetadata,
	extractModelFamily,
	discoverRunningProcesses,
} from "./lib/store.js";

const program = new Command();

program
	.name("lmgrep")
	.description("Semantic code search with any AI embedding provider")
	.version("0.1.0");

program
	.command("index")
	.description("Index the current directory for semantic search")
	.option("-r, --reset", "Reset and rebuild the entire index")
	.option("-v, --verbose", "Show file-by-file progress")
	.option(
		"-s, --since <duration>",
		"Only consider files modified within duration (e.g. 10m, 2h, 1d)",
	)
	.option(
		"-f, --force",
		"Force re-embed even if file hash unchanged (use with --since)",
	)
	.option("-d, --dry", "Show what would be indexed without actually doing it")
	.action(async (opts) => {
		const cwd = process.cwd();
		if (!opts.dry && isDbLocked(cwd)) {
			console.error(
				"Another process is writing to this index (serve or another lmgrep instance). Try again later.",
			);
			process.exit(1);
		}
		const index = await createIndex({ cwd });
		await index.build({
			reset: opts.reset,
			verbose: opts.verbose,
			since: opts.since,
			force: opts.force,
			dry: opts.dry,
		});
		await index.close();
	});

program
	.command("search <query>")
	.description("Search the codebase using natural language")
	.option("-m, --limit <n>", "Max results", "25")
	.option("--scores", "Show relevance scores")
	.option("--compact", "Show file paths only")
	.option("--json", "Output results as JSON")
	.option("--min-score <n>", "Minimum score threshold")
	.option(
		"--file-prefix <prefix>",
		"Only search files matching this path prefix",
	)
	.option("--not <query>", "Exclude results similar to this query")
	.option(
		"--type <types>",
		"Only return chunks of these AST types (comma-separated)",
	)
	.option(
		"--language <langs>",
		"Only return chunks from files with these extensions (comma-separated, e.g. .ts,.py)",
	)
	.option(
		"--project <path>",
		"Search a different project's index",
	)
	.option(
		"--across <paths>",
		"Search multiple project indexes (comma-separated paths)",
	)
	.action(async (query, opts) => {
		const cwd = process.cwd();
		const index = await createIndex({ cwd });
		const results = await index.search(query, {
			limit: Number.parseInt(opts.limit, 10),
			filePrefix: opts.filePrefix,
			not: opts.not,
			minScore: opts.minScore
				? Number.parseFloat(opts.minScore)
				: undefined,
			type: opts.type
				? opts.type.split(",").map((s: string) => s.trim())
				: undefined,
			language: opts.language
				? opts.language.split(",").map((s: string) => s.trim())
				: undefined,
			project: opts.project,
			across: opts.across
				? opts.across.split(",").map((s: string) => s.trim())
				: undefined,
		});

		if (opts.json) {
			console.log(JSON.stringify(results, null, 2));
			await index.close();
			return;
		}

		if (results.length === 0) {
			console.log("No results found.");
		} else if (opts.compact) {
			const seen = new Set<string>();
			for (const r of results) {
				if (!seen.has(r.filePath)) {
					seen.add(r.filePath);
					console.log(r.filePath);
				}
			}
		} else {
			for (const r of results) {
				const header = `${r.filePath}:${r.startLine}-${r.endLine} [${r.type}] ${r.name}`;
				const score = opts.scores
					? ` (score: ${r.score.toFixed(3)})`
					: "";
				console.log(`\n${"─".repeat(60)}`);
				console.log(`${header}${score}`);
				console.log(`${"─".repeat(60)}`);
				console.log(r.context);
				console.log();
				console.log(r.content);
			}
		}

		await index.close();
	});

program
	.command("status")
	.description("Show index stats and check embedding connectivity")
	.option("-c, --changes", "Scan for changed files since last index")
	.option("--json", "Output status as JSON")
	.action(async (opts) => {
		const cwd = process.cwd();
		const index = await createIndex({ cwd });
		const info = await index.status();

		const processes = discoverRunningProcesses();

		if (opts.json) {
			const output: Record<string, unknown> = { ...info, processes };
			if (opts.changes) {
				const projectRoot = info.projectRoot;
				const projectStore = Store.forProject(projectRoot);
				const storedFileHashes = await projectStore.getFileHashes();
				const currentFiles = walkFiles(projectRoot);
				const changes = computeChanges(
					projectRoot,
					currentFiles,
					storedFileHashes,
				);
				output.changes = changes;
				await projectStore.close();
			}
			console.log(JSON.stringify(output, null, 2));
			await index.close();
			return;
		}

		console.log(`Project root: ${info.projectRoot}`);
		if (info.prefix) console.log(`Subdirectory: ${info.prefix}`);
		console.log(`Model: ${info.config.model}`);
		if (info.config.provider)
			console.log(`Provider: ${info.config.provider}`);
		if (info.config.baseURL)
			console.log(`Base URL: ${info.config.baseURL}`);
		console.log(`Batch size: ${info.config.batchSize}`);
		if (info.config.maxTokens)
			console.log(`Max tokens: ${info.config.maxTokens}`);

		if (info.fileCount === 0) {
			console.log("\nNo index found. Run `lmgrep index` first.");
			await index.close();
			return;
		}

		console.log(`\nIndex stats:`);
		console.log(`  Files: ${info.fileCount}`);
		console.log(`  Chunks: ${info.chunkCount}`);
		console.log(`  Unique hashes: ${info.uniqueHashes}`);
		if (info.indexModel)
			console.log(`  Index model: ${info.indexModel}`);
		if (info.indexDimensions)
			console.log(`  Dimensions: ${info.indexDimensions}`);
		if (info.chunkCount !== info.uniqueHashes) {
			console.log(
				`  Duplicates: ${info.chunkCount - info.uniqueHashes}`,
			);
		}

		console.log(`\nEmbedding check:`);
		if (info.embeddingOk) {
			console.log(`  OK (${info.embeddingLatencyMs}ms)`);
		} else {
			console.log(`  FAILED`);
		}

		if (processes.length > 0) {
			console.log(`\nRunning processes:`);
			for (const proc of processes) {
				const kindLabel =
					proc.kind === "mcp" ? "MCP server" :
					proc.kind === "serve" ? "serve" :
					"CLI";
				const project = proc.projectRoot ?? "unknown";
				const watching = proc.watching ? ", watching" : "";
				console.log(`  ${kindLabel} (pid ${proc.pid})${watching}`);
				console.log(`    index: ${project}`);
			}
		} else {
			console.log(`\nNo running lmgrep processes.`);
		}

		if (opts.changes) {
			console.log(`\nScanning for changes...`);
			const projectRoot = info.projectRoot;
			const projectStore = Store.forProject(projectRoot);
			const storedFileHashes = await projectStore.getFileHashes();
			const currentFiles = walkFiles(projectRoot);
			const { added, modified, deleted } = computeChanges(
				projectRoot,
				currentFiles,
				storedFileHashes,
			);

			const total = added.length + modified.length + deleted.length;
			if (total === 0) {
				console.log("  No changes detected.");
			} else {
				if (added.length > 0) {
					console.log(`  Added: ${added.length}`);
					for (const f of added.slice(0, 10))
						console.log(`    + ${f}`);
					if (added.length > 10)
						console.log(
							`    ... and ${added.length - 10} more`,
						);
				}
				if (modified.length > 0) {
					console.log(`  Modified: ${modified.length}`);
					for (const f of modified.slice(0, 10))
						console.log(`    ~ ${f}`);
					if (modified.length > 10)
						console.log(
							`    ... and ${modified.length - 10} more`,
						);
				}
				if (deleted.length > 0) {
					console.log(`  Deleted: ${deleted.length}`);
					for (const f of deleted.slice(0, 10))
						console.log(`    - ${f}`);
					if (deleted.length > 10)
						console.log(
							`    ... and ${deleted.length - 10} more`,
						);
				}
				console.log(
					`\n  Run \`lmgrep index\` to update the index.`,
				);
			}
			await projectStore.close();
		}

		await index.close();
	});

program
	.command("repair")
	.description(
		"Detect and fix index inconsistencies (orphaned/stale chunks)",
	)
	.option(
		"-d, --dry",
		"Show what would be repaired without making changes",
	)
	.option("--json", "Output repair results as JSON")
	.action(async (opts) => {
		const cwd = process.cwd();
		const index = await createIndex({ cwd });
		const result = await index.repair(opts.dry);
		if (opts.json) {
			console.log(JSON.stringify(result, null, 2));
		}
		await index.close();
	});

program
	.command("serve")
	.description("Watch the current directory and re-index on changes")
	.action(async () => {
		const cwd = process.cwd();
		const index = await createIndex({ cwd });
		await index.watch();
	});

program
	.command("mcp")
	.description("Start the MCP server (stdio transport)")
	.action(async () => {
		await import("./mcp.js");
	});

program
	.command("init")
	.description("Detect your embedding setup and create config")
	.option("--force", "Overwrite existing config")
	.option(
		"--local",
		"Write a project-local .lmgrep.yml instead of the global config",
	)
	.action(async (opts) => {
		const cwd = process.cwd();
		const configPath = opts.local
			? join(cwd, ".lmgrep.yml")
			: getGlobalConfigPath();

		if (existsSync(configPath) && !opts.force) {
			console.error(
				`Config already exists at ${configPath}. Use --force to overwrite.`,
			);
			process.exit(1);
		}

		// Check if there's an existing index with model info
		const dbPath = getDbPath(cwd);
		const meta = existsSync(dbPath)
			? readProjectMetadata(dbPath)
			: undefined;
		const indexFamily = meta?.model
			? extractModelFamily(meta.model)
			: undefined;

		// Detect Ollama
		const ollama = await detectOllama();

		if (!ollama.running) {
			console.log("Ollama not detected.\n");
			console.log("Install Ollama:");
			console.log(
				"  curl -fsSL https://ollama.com/install.sh | sh\n",
			);
			if (indexFamily) {
				console.log(
					`This index was built with "${meta!.model}" (${meta!.dimensions} dims).`,
				);
				console.log(
					`After installing Ollama, pull a compatible model and run \`lmgrep init\` again.`,
				);
			} else {
				console.log(
					"After installing, run `lmgrep init` again to auto-configure.",
				);
			}
			// Still write a template config
			mkdirSync(join(configPath, ".."), { recursive: true });
			writeFileSync(configPath, buildConfigTemplate());
			console.log(
				`\nWrote ${configPath} (edit model before indexing)`,
			);
			return;
		}

		console.log("Found Ollama.");

		// If we have index metadata, try to find a compatible model
		let selectedModel: string | undefined;

		if (indexFamily && meta?.dimensions) {
			console.log(
				`Index built with "${meta.model}" (${indexFamily}, ${meta.dimensions} dims)`,
			);

			// Check if a compatible model is already pulled
			const compatible = ollama.models.find((m) => {
				const family = extractModelFamily(`ollama:${m}`);
				return family === indexFamily;
			});

			if (compatible) {
				selectedModel = compatible;
				console.log(`Found compatible model: ${compatible}`);
			} else {
				console.log(
					`\nNo compatible model found locally. You need a model from the "${indexFamily}" family.`,
				);
				console.log("Pull one with:");
				console.log(`  ollama pull ${indexFamily}\n`);
				console.log(
					"Then run `lmgrep init` again to auto-configure.",
				);
			}
		}

		// If no index constraint, pick the first embedding model or suggest one
		if (!selectedModel && !indexFamily) {
			if (ollama.models.length > 0) {
				// Prefer embedding-oriented models
				const embeddingModel = ollama.models.find(
					(m) =>
						m.includes("embed") ||
						m.includes("nomic") ||
						m.includes("bge") ||
						m.includes("minilm"),
				);
				selectedModel = embeddingModel ?? ollama.models[0];
				console.log(`Using model: ${selectedModel}`);
			} else {
				console.log("\nNo models found. Pull an embedding model:");
				console.log("  ollama pull nomic-embed-text\n");
				console.log("Then run `lmgrep init` again.");
			}
		}

		const modelString = selectedModel
			? `ollama:${selectedModel}`
			: undefined;

		mkdirSync(join(configPath, ".."), { recursive: true });
		writeFileSync(
			configPath,
			buildConfigTemplate({
				model: modelString,
				baseURL: modelString
					? "http://localhost:11434/v1"
					: undefined,
			}),
		);
		console.log(`Wrote ${configPath}`);
	});

program
	.command("config")
	.description("Open the global config file in your editor")
	.action(() => {
		const configPath = getGlobalConfigPath();
		if (!existsSync(configPath)) {
			console.error(
				`No config found at ${configPath}. Run \`lmgrep init\` first.`,
			);
			process.exit(1);
		}

		const editor =
			process.env.VISUAL ?? process.env.EDITOR ?? "vi";
		console.log(`Opening ${configPath}`);
		try {
			execSync(`${editor} ${configPath}`, { stdio: "inherit" });
		} catch {
			console.error(
				`Could not open editor "${editor}". Set $EDITOR or $VISUAL.`,
			);
			process.exit(1);
		}
	});

program
	.command("compact")
	.description("Compact the index to reclaim disk space")
	.action(async () => {
		const cwd = process.cwd();
		const store = Store.forProject(cwd);
		await store.compact();
		console.log("Compaction complete.");
		await store.close();
	});

program
	.command("prune")
	.description("Delete the index database for the current directory")
	.option("--force", "Skip confirmation")
	.action(async (opts) => {
		const cwd = process.cwd();
		const dbPath = getDbPath(cwd);

		if (!existsSync(dbPath)) {
			console.log("No index found for this directory.");
			return;
		}

		if (!opts.force) {
			const readline = await import("node:readline");
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});
			const answer = await new Promise<string>((resolve) => {
				rl.question(
					`Delete index at ${dbPath}? [y/N] `,
					resolve,
				);
			});
			rl.close();
			if (answer.toLowerCase() !== "y") {
				console.log("Cancelled.");
				return;
			}
		}

		rmSync(dbPath, { recursive: true, force: true });
		console.log(`Deleted index at ${dbPath}`);
	});

program
	.command("import [db-path]")
	.description(
		"Import chunks and file hashes from another lmgrep database. " +
			"If no path is given, tries to find a legacy index for this directory.",
	)
	.option("--reset", "Reset the current index before importing")
	.action(async (dbPath: string | undefined, opts) => {
		const cwd = process.cwd();

		let sourcePath: string;
		if (dbPath) {
			sourcePath = resolve(cwd, dbPath);
		} else {
			const legacy = getLegacyDbPath(cwd);
			if (existsSync(legacy)) {
				sourcePath = legacy;
				console.log(`Found legacy index at ${legacy}`);
			} else {
				console.error(
					"No legacy index found. Provide a path: lmgrep import <db-path>",
				);
				process.exit(1);
			}
		}

		if (!existsSync(sourcePath)) {
			console.error(`Database not found: ${sourcePath}`);
			process.exit(1);
		}

		const newDbPath = getDbPath(cwd);
		if (resolve(sourcePath) === resolve(newDbPath)) {
			console.error("Source and destination are the same database.");
			process.exit(1);
		}

		const store = Store.forProject(cwd);

		if (opts.reset) {
			await store.reset();
		}

		const { chunks, files } = await store.importFrom(sourcePath);
		console.log(
			`Imported ${chunks} chunks and ${files} file hashes from ${sourcePath}`,
		);

		// Show model info from source to guide the user
		const sourceMeta = readProjectMetadata(sourcePath);
		if (sourceMeta?.model) {
			const family = extractModelFamily(sourceMeta.model);
			console.log(
				`\nThis index was built with "${sourceMeta.model}" (${family}${sourceMeta.dimensions ? `, ${sourceMeta.dimensions} dims` : ""}).`,
			);
			console.log(
				`Configure a compatible model in .lmgrep.yml, then run \`lmgrep init\` to auto-detect.`,
			);
		}
		await store.close();
	});

{
	const completionsCmd = program
		.command("completions")
		.description("Output shell completions");

	// Resolve the completions directory relative to this script
	const completionsDir = join(import.meta.dirname!, "..", "completions");

	completionsCmd
		.command("zsh")
		.description("Output zsh completions")
		.option(
			"--install",
			"Install to site-functions and reload completions",
		)
		.action((opts) => {
			const script = readFileSync(
				join(completionsDir, "_lmgrep"),
				"utf-8",
			);
			if (opts.install) {
				const siteFunctions = findZshSiteFunctions();
				if (!siteFunctions) {
					console.error(
						"Could not find a writable zsh site-functions directory.\n" +
							"Output manually with: lmgrep completions zsh > /path/to/_lmgrep",
					);
					process.exit(1);
				}
				const target = join(siteFunctions, "_lmgrep");
				mkdirSync(siteFunctions, { recursive: true });
				writeFileSync(target, script);
				console.log(`Installed completions to ${target}`);
				console.log("Restart your shell or run: exec zsh");
				return;
			}
			console.log(script);
		});
}

// Auto-detect MCP mode: no args + both stdin and stdout are piped (stdio transport)
const userArgs = process.argv.slice(2);
if (userArgs.length === 0 && !process.stdin.isTTY && !process.stdout.isTTY) {
	await import("./mcp.js");
} else {
	program.parse();
}

// --- Zsh helpers ---

function findZshSiteFunctions(): string | undefined {
	// Prefer user-local paths, fall back to system paths
	const candidates = [
		join(homedir(), ".local", "share", "zsh", "site-functions"),
		"/usr/local/share/zsh/site-functions",
		"/usr/share/zsh/site-functions",
	];

	// Also check $fpath entries that contain "site-functions"
	try {
		const fpath = execSync("zsh -c 'echo $fpath'", {
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		})
			.toString()
			.trim();
		for (const p of fpath.split(" ")) {
			if (p.includes("site-functions") && !candidates.includes(p)) {
				candidates.push(p);
			}
		}
	} catch {}

	// Return the first candidate that exists or is in a writable parent
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) {
				// Check if writable
				writeFileSync(join(candidate, ".lmgrep-test"), "");
				rmSync(join(candidate, ".lmgrep-test"));
				return candidate;
			}
			// Check if parent is writable (we can create the dir)
			const parent = join(candidate, "..");
			if (existsSync(parent)) {
				mkdirSync(candidate, { recursive: true });
				return candidate;
			}
		} catch {
			// not writable, try next
		}
	}
	return undefined;
}

// --- Helpers ---

async function detectOllama(): Promise<{
	running: boolean;
	models: string[];
}> {
	try {
		const res = await fetch("http://localhost:11434/api/tags", {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) return { running: true, models: [] };
		const data = (await res.json()) as {
			models?: Array<{ name: string }>;
		};
		const models = (data.models ?? []).map((m) => m.name);
		return { running: true, models };
	} catch {
		return { running: false, models: [] };
	}
}

function buildConfigTemplate(
	overrides?: { model?: string; baseURL?: string },
): string {
	const model = overrides?.model;
	const hasModel = !!model;

	const modelLine = hasModel
		? `model: ${model}`
		: `# model: ollama:nomic-embed-text  # ← set your model here`;
	const baseURLLine = overrides?.baseURL
		? `baseURL: ${overrides.baseURL}`
		: `# baseURL: http://localhost:11434/v1`;

	return `# lmgrep configuration
#
# Quick start with Ollama:
#   1. Install: curl -fsSL https://ollama.com/install.sh | sh
#   2. Pull a model: ollama pull nomic-embed-text
#   3. Run: lmgrep init --force  (to auto-detect)

# Embedding model in "provider:model" format
${modelLine}

# Base URL for the embedding API
${baseURLLine}

# Batch size for embedding API calls
batchSize: 100

# Optional: override the provider package
# provider: "@ai-sdk/openai"

# Optional: embedding dimensions (if model supports it)
# dimensions: 384

# Optional: max tokens per chunk (estimated at 4 chars/token)
# maxTokens: 8192

# Optional: prefixes for asymmetric embedding models
# queryPrefix: "search_query: "
# documentPrefix: "search_document: "

# Optional: additional ignore patterns (merged with .gitignore)
# ignore:
#   - "*.generated.ts"
#   - "fixtures/"

# Optional: extra file extensions to index
# extensions:
#   include: [".sql", ".graphql", ".proto"]
#   exclude: [".json"]
`;
}

function computeChanges(
	projectRoot: string,
	currentFiles: string[],
	storedFileHashes: Map<string, string>,
): { added: string[]; modified: string[]; deleted: string[] } {
	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];
	const seen = new Set<string>();

	for (const file of currentFiles) {
		seen.add(file);
		try {
			const content = readFileSync(join(projectRoot, file));
			const fileHash = createHash("sha256")
				.update(content)
				.digest("hex")
				.slice(0, 16);
			const stored = storedFileHashes.get(file);
			if (!stored) {
				added.push(file);
			} else if (stored !== fileHash) {
				modified.push(file);
			}
		} catch {}
	}

	for (const [fp] of storedFileHashes) {
		if (!seen.has(fp)) deleted.push(fp);
	}

	return { added, modified, deleted };
}
