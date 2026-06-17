import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { Chunk, Chunker } from "../types.js";
import {
	buildContextString,
	classifyRole,
	extractLeadingComment,
	extractScope,
} from "./context.js";
import {
	type LanguageConfig,
	getLanguageForFile,
	getWasmPath,
} from "./languages.js";

const MAX_CHUNK_TOKENS = 8192;

let parserInstance: Parser | undefined;
const loadedLanguages = new Map<string, Language>();

async function getParser(): Promise<Parser> {
	if (!parserInstance) {
		await Parser.init();
		parserInstance = new Parser();
	}
	return parserInstance;
}

async function getLanguage(
	langConfig: LanguageConfig,
): Promise<Language | undefined> {
	const cached = loadedLanguages.get(langConfig.id);
	if (cached) return cached;

	const wasmPath = getWasmPath(langConfig);
	if (!wasmPath) return undefined;

	const lang = await Language.load(wasmPath);
	loadedLanguages.set(langConfig.id, lang);
	return lang;
}

/** Chunk a single file into context-enriched chunks */
export async function chunkFile(
	filePath: string,
	cwd: string,
): Promise<Chunk[]> {
	const langConfig = getLanguageForFile(filePath);
	if (!langConfig) return fallbackChunk(filePath, cwd);

	const parser = await getParser();
	const language = await getLanguage(langConfig);
	if (!language) return fallbackChunk(filePath, cwd);

	parser.setLanguage(language);

	const absolutePath = join(cwd, filePath);
	const source = readFileSync(absolutePath, "utf-8");
	const tree = parser.parse(source);
	if (!tree) return fallbackChunk(filePath, cwd);

	if (langConfig.id === "markdown") {
		const md = markdownChunks(tree.rootNode, filePath, source);
		return md.length > 0 ? md : fallbackChunk(filePath, cwd);
	}

	const chunks: Chunk[] = [];
	collectChunks(tree.rootNode, langConfig, filePath, source, chunks);

	if (chunks.length === 0) {
		return fallbackChunk(filePath, cwd);
	}

	return chunks;
}

/**
 * Markdown-specific chunking. The block grammar's `section` nodes nest by
 * heading level, so emitting them whole collapses a doc into one chunk. Instead
 * we split at every heading the grammar reports (so a `#` inside a fenced code
 * block isn't mistaken for one) — each chunk spans a heading and its body up to
 * the next heading. Result: complete, non-overlapping, heading-granular chunks.
 */
function markdownChunks(root: Node, filePath: string, source: string): Chunk[] {
	const lines = source.split("\n");

	const headingRows: number[] = [];
	const visit = (node: Node): void => {
		if (node.type === "atx_heading" || node.type === "setext_heading") {
			headingRows.push(node.startPosition.row);
		}
		for (const child of node.children) visit(child);
	};
	visit(root);

	// Split points: start of file plus each heading row, sorted and deduped.
	const starts = [...new Set([0, ...headingRows])].sort((a, b) => a - b);
	const chunks: Chunk[] = [];

	for (let i = 0; i < starts.length; i++) {
		const start = starts[i];
		const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
		const content = lines.slice(start, end).join("\n");
		if (content.trim().length === 0) continue;

		const headingText = (lines[start] ?? "").replace(/^\s*#+\s*/, "").trim();
		const name = headingText.slice(0, 80) || `lines_${start + 1}_${end}`;
		const hash = createHash("sha256")
			.update(content)
			.digest("hex")
			.slice(0, 16);

		chunks.push({
			id: `${filePath}:${start}:${hash}`,
			filePath,
			startLine: start + 1,
			endLine: end,
			type: "section",
			name,
			content,
			context: `[file: ${filePath}]`,
			hash,
		});
	}

	return chunks;
}

function collectChunks(
	node: Node,
	langConfig: LanguageConfig,
	filePath: string,
	source: string,
	chunks: Chunk[],
): void {
	if (langConfig.chunkTypes.includes(node.type)) {
		const content = node.text;

		// If too large, recurse into children instead
		const estimatedTokens = Math.ceil(content.length / 4);
		if (
			estimatedTokens > MAX_CHUNK_TOKENS &&
			hasChunkableDescendants(node, langConfig)
		) {
			for (const child of node.children) {
				collectChunks(child, langConfig, filePath, source, chunks);
			}
			return;
		}

		const name =
			extractNodeName(node) ?? `anonymous_${node.startPosition.row}`;

		// Skip very small chunks
		if (content.split("\n").length < 2 && content.length < 50) {
			return;
		}

		const scope = extractScope(node, langConfig);
		const leadingComment = extractLeadingComment(node, source);
		const role = classifyRole(node);

		const context = buildContextString({
			filePath,
			scope,
			leadingComment,
			role,
		});

		const hash = createHash("sha256")
			.update(content)
			.digest("hex")
			.slice(0, 16);

		chunks.push({
			id: `${filePath}:${node.startPosition.row}:${hash}`,
			filePath,
			startLine: node.startPosition.row + 1,
			endLine: node.endPosition.row + 1,
			type: node.type,
			name,
			content,
			context,
			hash,
		});
		return;
	}

	for (const child of node.children) {
		collectChunks(child, langConfig, filePath, source, chunks);
	}
}

function hasChunkableDescendants(
	node: Node,
	langConfig: LanguageConfig,
): boolean {
	for (const child of node.children) {
		if (langConfig.chunkTypes.includes(child.type)) return true;
		if (hasChunkableDescendants(child, langConfig)) return true;
	}
	return false;
}

function extractNodeName(node: Node): string | undefined {
	const nameNode =
		node.childForFieldName("name") ??
		node.children.find(
			(c: Node) =>
				c.type === "identifier" ||
				c.type === "type_identifier" ||
				// nix bindings name their target via an attrpath (e.g. `outputs = ...`)
				c.type === "attrpath",
		);
	return nameNode?.text;
}

/**
 * Fallback: chunk by sliding window for files with no grammar or no chunkable
 * structure (e.g. linear shell scripts). A small window overlap keeps a passage
 * spanning a window boundary recallable; it's kept light (20%) because the
 * extra rows are pure index bloat now that search dedups overlapping results.
 */
function fallbackChunk(filePath: string, cwd: string): Chunk[] {
	const absolutePath = join(cwd, filePath);
	const source = readFileSync(absolutePath, "utf-8");
	const lines = source.split("\n");

	if (lines.length === 0) return [];

	const WINDOW = 50;
	const STRIDE = 40;
	const chunks: Chunk[] = [];

	for (let i = 0; i < lines.length; i += STRIDE) {
		const slice = lines.slice(i, i + WINDOW);
		const content = slice.join("\n");
		if (content.trim().length === 0) continue;

		const hash = createHash("sha256")
			.update(content)
			.digest("hex")
			.slice(0, 16);

		chunks.push({
			id: `${filePath}:${i}:${hash}`,
			filePath,
			startLine: i + 1,
			endLine: Math.min(i + WINDOW, lines.length),
			type: "block",
			name: `lines_${i + 1}_${Math.min(i + WINDOW, lines.length)}`,
			content,
			context: `[file: ${filePath}]`,
			hash,
		});
	}

	return chunks;
}

/** Default chunker using tree-sitter with sliding-window fallback */
export class TreeSitterChunker implements Chunker {
	async chunk(filePath: string, cwd: string): Promise<Chunk[]> {
		return chunkFile(filePath, cwd);
	}
}
