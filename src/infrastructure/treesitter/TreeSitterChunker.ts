import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Language, type Node, Parser } from "web-tree-sitter";
import { Chunk } from "../../domain/corpus/Chunk.js";
import { CodeLocation } from "../../domain/corpus/CodeLocation.js";
import { ContentHash } from "../../domain/corpus/ContentHash.js";
import type { ChunkerPort } from "../../domain/ports/ChunkerPort.js";
import { ChunkContextBuilder } from "./ChunkContextBuilder.js";
import { embeddedParserPath } from "./EmbeddedTreeSitterAssets.js";
import { LanguageCatalog, type LanguageConfig } from "./LanguageCatalog.js";
import { SlidingWindowChunker } from "./SlidingWindowChunker.js";

/**
 * Splits source into chunks along AST boundaries.
 *
 * Functions and methods are isolated from enclosing declarations and state.
 * Files with no grammar, or no chunkable structure, fall back to a sliding
 * window.
 */
export class TreeSitterChunker implements ChunkerPort {
	private static readonly MAX_CHUNK_TOKENS = 8192;
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

		try {
			if (language.id === "markdown") {
				return this.chunkMarkdown(tree.rootNode, filePath, source);
			}
			const spans: Array<{ node: Node; start: number; end: number }> = [];
			for (const node of tree.rootNode.namedChildren) {
				const before = spans.length;
				this.collect(node, language, spans);
				if (!this.isContextOnly(node, language)) {
					const covered = spans.slice(before).sort((a, b) => a.start - b.start);
					let cursor = node.startIndex;
					for (const span of covered) {
						this.addSpan(node, cursor, span.start, spans);
						cursor = Math.max(cursor, span.end);
					}
					this.addSpan(node, cursor, node.endIndex, spans);
				}
			}
			const chunks = spans
				.sort((a, b) => a.start - b.start)
				.map(({ node, start, end }) => {
					const content = source.slice(start, end);
					const scope = this.context.extractScope(node, language);
					const name = this.nodeName(node);
					const qualifiedName = name
						? [...scope.map((entry) => entry.name), name].join(".")
						: `lines_${source.slice(0, start).split("\n").length}`;
					return new Chunk({
						location: new CodeLocation(
							filePath,
							source.slice(0, start).split("\n").length,
							source.slice(0, end).split("\n").length -
								(content.endsWith("\n") ? 1 : 0),
						),
						type: language.chunkTypes.includes(node.type) ? node.type : "block",
						name: qualifiedName,
						content,
						context: `${this.context.build(node, filePath, source, language)}\n[symbol: ${qualifiedName}]`,
						hash: ContentHash.of(content),
					});
				});
			return chunks.length > 0 ? chunks : this.fallback.chunk(filePath, cwd);
		} finally {
			tree.delete();
		}
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
		spans: Array<{ node: Node; start: number; end: number }>,
		start = node.startIndex,
		end = node.endIndex,
	): void {
		if (
			node.type === "export_statement" ||
			node.type === "decorated_definition"
		) {
			const declaration =
				node.childForFieldName("declaration") ??
				node.childForFieldName("definition");
			if (declaration) {
				this.collect(declaration, language, spans, start, end);
				return;
			}
		}
		if (node.type === "variable_declarator") {
			const value = node.childForFieldName("value");
			if (value?.type === "arrow_function") {
				this.collect(value, language, spans, start, end);
				return;
			}
		}
		if (!language.chunkTypes.includes(node.type)) {
			const children = node.namedChildren;
			if (
				(node.type === "lexical_declaration" ||
					node.type === "variable_declaration") &&
				children.length === 1
			) {
				this.collect(children[0], language, spans, start, end);
			} else {
				for (const child of children) this.collect(child, language, spans);
			}
			return;
		}
		const split =
			(language.scopeTypes.includes(node.type) ||
				Math.ceil(node.text.length / 4) > TreeSitterChunker.MAX_CHUNK_TOKENS) &&
			this.hasChunkableDescendants(node, language);
		if (split) {
			const before = spans.length;
			for (const child of node.namedChildren)
				this.collect(child, language, spans);
			const children = spans.slice(before).sort((a, b) => a.start - b.start);
			let cursor = start;
			for (const child of children) {
				this.addSpan(node, cursor, child.start, spans);
				cursor = child.end;
			}
			this.addSpan(node, cursor, end, spans);
			return;
		}
		const name = this.nodeName(node);
		if (
			!name &&
			!node.text.includes("\n") &&
			node.text.length < TreeSitterChunker.MIN_CHUNK_CHARS
		) {
			return;
		}
		if (node.type === "arrow_function") {
			if (this.testName(node)) {
				const call = node.parent?.parent;
				if (call) {
					start = call.startIndex;
					end = call.endIndex;
				}
			} else if (node.parent?.type === "public_field_definition") {
				start = node.parent.startIndex;
				end = node.parent.endIndex;
			}
		}
		spans.push({ node, start, end });
	}

	private addSpan(
		node: Node,
		start: number,
		end: number,
		spans: Array<{ node: Node; start: number; end: number }>,
	): void {
		let enclosing = node;
		while (
			enclosing.parent &&
			(start < enclosing.startIndex || end > enclosing.endIndex)
		) {
			enclosing = enclosing.parent;
		}
		const content = enclosing.text.slice(
			start - enclosing.startIndex,
			end - enclosing.startIndex,
		);
		const meaningful = content
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(?:\/\/|#|--)[^\n]*/g, "");
		if (/[\p{L}\p{N}_]/u.test(meaningful)) {
			spans.push({
				node,
				start: start + content.length - content.trimStart().length,
				end: end - content.length + content.trimEnd().length,
			});
		}
	}

	private isContextOnly(node: Node, language: LanguageConfig): boolean {
		return (
			node.type === "comment" ||
			(language.importTypes.includes(node.type) &&
				!["call_expression", "call", "command"].includes(node.type))
		);
	}

	private hasChunkableDescendants(
		node: Node,
		language: LanguageConfig,
	): boolean {
		return node.namedChildren.some(
			(child) =>
				language.chunkTypes.includes(child.type) ||
				this.hasChunkableDescendants(child, language),
		);
	}

	private testName(node: Node): string | undefined {
		const call = node.parent?.type === "arguments" ? node.parent.parent : null;
		if (call?.type !== "call_expression") return undefined;
		const callee = call.childForFieldName("function")?.text;
		if (!callee || !/^(?:test|it)(?:\.(?:only|skip|todo))?$/.test(callee))
			return undefined;
		const label = node.parent?.namedChildren.find(
			(child) => child.type === "string",
		);
		return label ? `${callee}: ${label.text.slice(1, -1)}` : undefined;
	}

	private nodeName(node: Node): string | undefined {
		if (node.type === "arrow_function") {
			return (
				this.testName(node) ??
				(node.parent &&
				["variable_declarator", "public_field_definition"].includes(
					node.parent.type,
				)
					? node.parent.childForFieldName("name")?.text
					: undefined)
			);
		}
		return (
			node.childForFieldName("name") ??
			node.children.find(
				(child) =>
					child.type === "identifier" ||
					child.type === "type_identifier" ||
					child.type === "attrpath",
			)
		)?.text;
	}

	private async getParser(): Promise<Parser> {
		if (!this.parser) {
			const parserWasm = embeddedParserPath();
			await Parser.init(
				parserWasm ? { locateFile: () => parserWasm } : undefined,
			);
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
