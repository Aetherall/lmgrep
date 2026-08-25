#!/usr/bin/env node
// Backfill the vocab table from existing chunks — cheaper than re-indexing.
//
// `lmgrep facet index` covers the ordinary case. This script exists for two
// things it does not: it skips .json chunks (their keys pollute the vocabulary
// with structure rather than domain words), and DRY_RUN=1 prints a document-
// frequency histogram for choosing a --min-df threshold.

import { Lexicon } from "../dist/domain/faceting/Lexicon.js";
import { ProjectLocator } from "../dist/domain/project/ProjectLocator.js";
import { AiSdkEmbedder } from "../dist/infrastructure/ai/AiSdkEmbedder.js";
import { ConfigLoader } from "../dist/infrastructure/fs/ConfigLoader.js";
import { StateDirectory } from "../dist/infrastructure/fs/StateDirectory.js";
import { GitClient } from "../dist/infrastructure/git/GitClient.js";
import { LanceTables } from "../dist/infrastructure/lancedb/LanceTables.js";
import { VocabRepository } from "../dist/infrastructure/lancedb/VocabRepository.js";

const cwd = process.argv[2] ?? process.cwd();

const config = new ConfigLoader().load(cwd);
const embedder = new AiSdkEmbedder(config);
const locator = new ProjectLocator(new GitClient(), new StateDirectory());
const location = locator.resolveDatabase(cwd);
const tables = new LanceTables(location.path, location.branch);
const vocab = new VocabRepository(tables);
const lexicon = new Lexicon();

console.error(`Scanning chunks for vocab in ${cwd}...`);

const chunks = await tables.table("chunks");
if (!chunks) {
	console.error("No chunks table. Run `lmgrep index` first.");
	process.exit(1);
}

const total = await chunks.countRows();
console.error(`Total chunks: ${total}`);

const df = new Map();
let scanned = 0;
let skippedJson = 0;
const BATCH_SCAN = 2000;

for (let offset = 0; offset < total; offset += BATCH_SCAN) {
	const rows = await chunks
		.query()
		.select(["name", "content", "filePath"])
		.limit(BATCH_SCAN)
		.offset(offset)
		.toArray();
	if (rows.length === 0) break;

	for (const row of rows) {
		if ((row.filePath ?? "").endsWith(".json")) {
			skippedJson++;
			continue;
		}
		scanned++;
		const seen = new Set();
		for (const term of lexicon.tokenize(
			`${row.name ?? ""} ${row.content ?? ""}`,
		)) {
			if (seen.has(term)) continue;
			seen.add(term);
			df.set(term, (df.get(term) ?? 0) + 1);
		}
	}
	console.error(
		`  scanned ${scanned}/${total} chunks, ${df.size} terms (skipped ${skippedJson} .json)`,
	);
}

console.error(`Total: ${scanned} chunks, ${df.size} unique terms`);

const MIN_DF = Number(process.env.MIN_DF ?? 10);
const candidates = [...df.entries()]
	.filter(([, c]) => c >= MIN_DF)
	.map(([t]) => t);
console.error(`Keeping ${candidates.length} terms (df >= ${MIN_DF})`);

if (process.env.DRY_RUN) {
	const all = [...df.entries()];
	console.error("\nDF thresholds:");
	for (const threshold of [2, 3, 5, 10, 20, 50]) {
		console.error(
			`  df >= ${threshold}: ${all.filter(([, c]) => c >= threshold).length}`,
		);
	}
	const sorted = all.filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
	const dump = (label, entries) => {
		console.error(`\n${label}:`);
		for (const [t, c] of entries) console.error(`  ${c}\t${t}`);
	};
	dump("Top 50 (by df)", sorted.slice(0, 50));
	const mid = sorted.findIndex(([, c]) => c <= 10);
	dump("Mid 50 (around df=10)", sorted.slice(mid, mid + 50));
	dump("Bottom 50 (df=2)", sorted.slice(-50));
	tables.close();
	process.exit(0);
}

const known = await vocab.storedTerms();
const toEmbed = candidates.filter((t) => !known.has(t));
console.error(
	`Need to embed ${toEmbed.length} new terms (${known.size} cached)`,
);

if (toEmbed.length === 0) {
	console.error("Nothing to do.");
	tables.close();
	process.exit(0);
}

const BATCH = 500;
for (let i = 0; i < toEmbed.length; i += BATCH) {
	const slice = toEmbed.slice(i, i + BATCH);
	const vectors = await embedder.embedDocuments(slice);
	await vocab.add(slice.map((term, j) => ({ term, vector: vectors[j] })));
	console.error(
		`  embedded ${Math.min(i + BATCH, toEmbed.length)}/${toEmbed.length}`,
	);
}

tables.close();
console.error(`Done. Vocab table has ~${known.size + toEmbed.length} terms.`);
