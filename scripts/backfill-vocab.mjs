#!/usr/bin/env node
// Backfill the vocab table from existing chunks — cheaper than re-indexing.

import { connect } from "@lancedb/lancedb";
import { loadConfig } from "../dist/lib/config.js";
import { AISDKEmbedder } from "../dist/lib/embedder.js";
import { Store, getDbPath } from "../dist/lib/store.js";
import { tokenize } from "../dist/lib/vocab.js";

const cwd = process.argv[2] ?? process.cwd();

const config = loadConfig(cwd);
const embedder = new AISDKEmbedder(config);
const store = Store.forProject(cwd);

console.error(`Scanning chunks for vocab in ${cwd}...`);

// Open LanceDB directly so we can select only name/content (skip vectors)
const dbPath = getDbPath(cwd);
const db = await connect(dbPath);
const chunksTable = await db.openTable("chunks");
const total = await chunksTable.countRows();
console.error(`Total chunks: ${total}`);

const df = new Map();
let chunkCount = 0;
let skippedJson = 0;
const BATCH_SCAN = 2000;
for (let offset = 0; offset < total; offset += BATCH_SCAN) {
	const rows = await chunksTable.query().select(["name", "content", "filePath"]).limit(BATCH_SCAN).offset(offset).toArray();
	if (rows.length === 0) break;
	for (const row of rows) {
		const fp = row.filePath ?? "";
		if (fp.endsWith(".json")) { skippedJson++; continue; }
		chunkCount++;
		const seen = new Set();
		const text = `${row.name ?? ""} ${row.content ?? ""}`;
		for (const t of tokenize(text)) {
			if (!seen.has(t)) {
				df.set(t, (df.get(t) ?? 0) + 1);
				seen.add(t);
			}
		}
	}
	console.error(`  scanned ${chunkCount}/${total} chunks, ${df.size} terms (skipped ${skippedJson} .json)`);
}

console.error(`Total: ${chunkCount} chunks, ${df.size} unique terms`);

const MIN_DF = Number(process.env.MIN_DF ?? 10);
const candidates = [...df.entries()]
	.filter(([, c]) => c >= MIN_DF)
	.map(([t]) => t);
console.error(`Keeping ${candidates.length} terms (df >= ${MIN_DF})`);

if (process.env.DRY_RUN) {
	const all = [...df.entries()];
	console.error("\nDF thresholds:");
	for (const th of [2, 3, 5, 10, 20, 50]) {
		console.error(`  df >= ${th}: ${all.filter(([, c]) => c >= th).length}`);
	}
	const sorted = all.filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
	console.error("\nTop 50 (by df):");
	for (const [t, c] of sorted.slice(0, 50)) console.error(`  ${c}\t${t}`);
	console.error("\nMid 50 (around df=10):");
	const mid = sorted.findIndex(([, c]) => c <= 10);
	for (const [t, c] of sorted.slice(mid, mid + 50)) console.error(`  ${c}\t${t}`);
	console.error("\nBottom 50 (df=2):");
	for (const [t, c] of sorted.slice(-50)) console.error(`  ${c}\t${t}`);
	console.error("\n30 random:");
	const shuffled = [...sorted].sort(() => Math.random() - 0.5).slice(0, 30);
	for (const [t, c] of shuffled) console.error(`  ${c}\t${t}`);
	await store.close();
	process.exit(0);
}

const known = await store.getVocabTerms();
const toEmbed = candidates.filter((t) => !known.has(t));
console.error(`Need to embed ${toEmbed.length} new terms (${known.size} cached)`);

if (toEmbed.length === 0) {
	console.error("Nothing to do.");
	await store.close();
	process.exit(0);
}

const BATCH = 500;
for (let i = 0; i < toEmbed.length; i += BATCH) {
	const slice = toEmbed.slice(i, i + BATCH);
	const vectors = await embedder.embed(slice);
	const entries = slice.map((term, j) => ({ term, vector: vectors[j] }));
	await store.addVocab(entries);
	console.error(`  embedded ${Math.min(i + BATCH, toEmbed.length)}/${toEmbed.length}`);
}

await store.close();
console.error(`Done. Vocab table has ~${known.size + toEmbed.length} terms.`);
