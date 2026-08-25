import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Language, type Node, Parser } from "web-tree-sitter";
import { Chunk } from "../../domain/corpus/Chunk.js";
import { CodeLocation } from "../../domain/corpus/CodeLocation.js";
import { ContentHash } from "../../domain/corpus/ContentHash.js";
import type { ChunkerPort } from "../../domain/ports/ChunkerPort.js";
import { ChunkContextBuilder } from "./ChunkContextBuilder.js";
import { LanguageCatalog, type LanguageConfig } from "./LanguageCatalog.js";
import { SlidingWindowChunker } from "./SlidingWindowChunker.js";

/**
 * Splits source into chunks along AST boundaries.
 *
 * Node-bounded chunks are what make results readable: a hit is a whole
 * function or class, not an arbitrary window through the middle of one. Files
 * with no grammar, or no chunkable structure, fall back to a sliding window.
 */
export class TreeSitterChunker implements ChunkerPort {
	/** Chunks larger than this are split by recursing into their children. */
	private static readonly MAX_CHUNK_TOKENS = 8192;
	/** A one-line fragment shorter than this is noise, not a unit of code. */
	private static readonly MIN_CHUNK_CHARS = 50;

	private parser: Parser | undefined;
	private readonly loaded = new Map<string, Language>();

	constructor(
		private readonly catalog = new LanguageCatalog(),
		private readonly context = new ChunkContextBuilder(),
		private readonly fallback = new SlidingWindowChunker(),
	) {}

	async chunk(filePath: string, cwd: string): Promise<Chunk[]> {
		const language = this.catalog.forFile(filePath);
		if (!language) return this.fallback.chunk(filePath, cwd);

		// Parser.init() must run before any Language.load(): it bootstraps the
		// wasm runtime that grammar loading calls into. Reversing these two
		// lines fails with "cannot read loadWebAssemblyModule of undefined".
		const parser = await this.getParser();

		const grammar = await this.loadGrammar(language);
		if (!grammar) return this.fallback.chunk(filePath, cwd);

		parser.setLanguage(grammar);

		const source = readFileSync(join(cwd, filePath), "utf-8");
		const tree = parser.parse(source);
		if (!tree) return this.fallback.chunk(filePath, cwd);

		const chunks =
			language.id === "markdown"
				? this.chunkMarkdown(tree.rootNode, filePath, source)
				: this.collect(tree.rootNode, language, filePath, source, []);

		return chunks.length > 0 ? chunks : this.fallback.chunk(filePath, cwd);
	}

	/**
	 * Markdown needs its own pass: the block grammar nests `section` nodes by
	 * heading level, so emitting them whole would collapse a document into one
	 * chunk. Splitting at every heading the grammar reports (so a `#` inside a
	 * fenced code block is not mistaken for one) gives complete,
	 * non-overlapping, heading-granular chunks instead.
	 */
	private chunkMarkdown(root: Node, filePath: string, source: string): Chunk[] {
		const lines = source.split("\n");

		const headingRows: number[] = [];
		const visit = (node: Node): void => {
			if (node.type === "atx_heading" || node.type === "setext_heading") {
				headingRows.push(node.startPosition.row);
			}
			for (const child of node.children) visit(child);
		};
		visit(root);

		const starts = [...new Set([0, ...headingRows])].sort((a, b) => a - b);
		const chunks: Chunk[] = [];

		for (let i = 0; i < starts.length; i++) {
			const start = starts[i];
			const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
			const content = lines.slice(start, end).join("\n");
			if (content.trim().length === 0) continue;

			const heading = (lines[start] ?? "").replace(/^\s*#+\s*/, "").trim();
			chunks.push(
				new Chunk({
					location: new CodeLocation(filePath, start + 1, end),
					type: "section",
					name: heading.slice(0, 80) || `lines_${start + 1}_${end}`,
					content,
					context: this.context.buildFileOnly(filePath),
					hash: ContentHash.of(content),
				}),
			);
		}

		return chunks;
	}

	private collect(
		node: Node,
		language: LanguageConfig,
		filePath: string,
		source: string,
		chunks: Chunk[],
	): Chunk[] {
		if (!language.chunkTypes.includes(node.type)) {
			for (const child of node.children) {
				this.collect(child, language, filePath, source, chunks);
			}
			return chunks;
		}

		const content = node.text;

		// Too large to embed whole: descend instead, so a big class becomes its
		// methods rather than being truncated or skipped.
		const estimatedTokens = Math.ceil(content.length / 4);
		if (
			estimatedTokens > TreeSitterChunker.MAX_CHUNK_TOKENS &&
			this.hasChunkableDescendants(node, language)
		) {
			for (const child of node.children) {
				this.collect(child, language, filePath, source, chunks);
			}
			return chunks;
		}

		// A short one-liner carries no retrievable meaning on its own.
		if (
			content.split("\n").length < 2 &&
			content.length < TreeSitterChunker.MIN_CHUNK_CHARS
		) {
			return chunks;
		}

		chunks.push(
			new Chunk({
				location: new CodeLocation(
					filePath,
					node.startPosition.row + 1,
					node.endPosition.row + 1,
				),
				type: node.type,
				name: this.nodeName(node) ?? `anonymous_${node.startPosition.row}`,
				content,
				context: this.context.build(node, filePath, source, language),
				hash: ContentHash.of(content),
			}),
		);
		return chunks;
	}

	private hasChunkableDescendants(
		node: Node,
		language: LanguageConfig,
	): boolean {
		for (const child of node.children) {
			if (language.chunkTypes.includes(child.type)) return true;
			if (this.hasChunkableDescendants(child, language)) return true;
		}
		return false;
	}

	private nodeName(node: Node): string | undefined {
		return (
			node.childForFieldName("name") ??
			node.children.find(
				(c: Node) =>
					c.type === "identifier" ||
					c.type === "type_identifier" ||
					// nix binds its target via an attrpath (e.g. `outputs = ...`)
					c.type === "attrpath",
			)
		)?.text;
	}

	private async getParser(): Promise<Parser> {
		if (!this.parser) {
			await Parser.init();
			this.parser = new Parser();
		}
		return this.parser;
	}

	/**
	 * Grammars are cached for the process lifetime. They are wasm modules whose
	 * linear memory only ever grows, so loading one repeatedly would leak.
	 */
	private async loadGrammar(
		language: LanguageConfig,
	): Promise<Language | undefined> {
		const cached = this.loaded.get(language.id);
		if (cached) return cached;

		const wasmPath = this.catalog.wasmPathFor(language);
		if (!wasmPath) return undefined;

		const grammar = await Language.load(wasmPath);
		this.loaded.set(language.id, grammar);
		return grammar;
	}
}
