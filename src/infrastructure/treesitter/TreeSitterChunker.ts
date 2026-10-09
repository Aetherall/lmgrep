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

	private parser: Promise<Parser> | undefined;
	private readonly loaded = new Map<string, Promise<Language | undefined>>();

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

		const source = readFileSync(join(cwd, filePath), "utf-8");
		parser.setLanguage(grammar);
		const tree = parser.parse(source);
		if (!tree) return this.fallback.chunkSource(filePath, source);

		try {
			if (language.id === "markdown") {
				return this.chunkMarkdown(tree.rootNode, filePath, source);
			}
			const spans: Array<{ node: Node; start: number; end: number }> = [];
			for (const node of tree.rootNode.namedChildren) {
				const before = spans.length;
				this.collect(node, language, source, spans);
				if (!this.isContextOnly(node, language)) {
					const covered = spans.slice(before).sort((a, b) => a.start - b.start);
					let cursor = node.startIndex;
					for (const span of covered) {
						this.addSpan(node, cursor, span.start, source, spans);
						cursor = Math.max(cursor, span.end);
					}
					this.addSpan(node, cursor, node.endIndex, source, spans);
				}
			}
			const lines = source.split("\n");
			const lineAt = this.lineLookup(lines);
			const chunks = spans
				.sort((a, b) => a.start - b.start)
				.map(({ node, start, end }) => {
					const content = source.slice(start, end);
					const scope = this.context.extractScope(node, language);
					const name = this.nodeName(node);
					const startLine = lineAt(start);
					const qualifiedName = name
						? [...scope.map((entry) => entry.name), name].join(".")
						: `lines_${startLine}`;
					return new Chunk({
						location: new CodeLocation(
							filePath,
							startLine,
							lineAt(end) - (content.endsWith("\n") ? 1 : 0),
						),
						type: language.chunkTypes.includes(node.type) ? node.type : "block",
						name: qualifiedName,
						content,
						context: `${this.context.build(node, filePath, lines, scope)}\n[symbol: ${qualifiedName}]`,
						hash: ContentHash.of(content),
					});
				});
			return chunks.length > 0
				? chunks
				: this.fallback.chunkSource(filePath, source);
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
		source: string,
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
				this.collect(declaration, language, source, spans, start, end);
				return;
			}
		}
		if (node.type === "variable_declarator") {
			const value = node.childForFieldName("value");
			if (value?.type === "arrow_function") {
				this.collect(value, language, source, spans, start, end);
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
				this.collect(children[0], language, source, spans, start, end);
			} else {
				for (const child of children)
					this.collect(child, language, source, spans);
			}
			return;
		}
		const length = node.endIndex - node.startIndex;
		const split =
			(language.scopeTypes.includes(node.type) ||
				Math.ceil(length / 4) > TreeSitterChunker.MAX_CHUNK_TOKENS) &&
			this.hasChunkableDescendants(node, language);
		if (split) {
			const before = spans.length;
			for (const child of node.namedChildren)
				this.collect(child, language, source, spans);
			const children = spans.slice(before).sort((a, b) => a.start - b.start);
			let cursor = start;
			for (const child of children) {
				this.addSpan(node, cursor, child.start, source, spans);
				cursor = child.end;
			}
			this.addSpan(node, cursor, end, source, spans);
			return;
		}
		const name = this.nodeName(node);
		const newline = source.indexOf("\n", node.startIndex);
		if (
			!name &&
			(newline === -1 || newline >= node.endIndex) &&
			length < TreeSitterChunker.MIN_CHUNK_CHARS
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
		source: string,
		spans: Array<{ node: Node; start: number; end: number }>,
	): void {
		const content = source.slice(start, end);
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

	/**
	 * Offset to 1-based line number by binary search over line start offsets,
	 * so a file costs one pass however many chunks it yields.
	 */
	private lineLookup(lines: string[]): (offset: number) => number {
		const starts = new Array<number>(lines.length);
		let offset = 0;
		for (let i = 0; i < lines.length; i++) {
			starts[i] = offset;
			offset += lines[i].length + 1;
		}
		return (target) => {
			let low = 0;
			let high = starts.length;
			while (low < high) {
				const mid = (low + high) >>> 1;
				if (starts[mid] <= target) low = mid + 1;
				else high = mid;
			}
			return low;
		};
	}

	/** Memoized as a promise so concurrent calls share one initialization. */
	private getParser(): Promise<Parser> {
		this.parser ??= (async () => {
			const parserWasm = embeddedParserPath();
			await Parser.init(
				parserWasm ? { locateFile: () => parserWasm } : undefined,
			);
			return new Parser();
		})();
		return this.parser;
	}

	/**
	 * Grammars are cached for the process lifetime. They are wasm modules whose
	 * linear memory only ever grows, so loading one repeatedly would leak.
	 */
	private loadGrammar(language: LanguageConfig): Promise<Language | undefined> {
		let grammar = this.loaded.get(language.id);
		if (!grammar) {
			const wasmPath = this.catalog.wasmPathFor(language);
			grammar = wasmPath ? Language.load(wasmPath) : Promise.resolve(undefined);
			this.loaded.set(language.id, grammar);
		}
		return grammar;
	}
}
