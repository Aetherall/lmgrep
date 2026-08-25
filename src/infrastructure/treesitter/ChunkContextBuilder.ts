import type { Node } from "web-tree-sitter";
import type { LanguageConfig } from "./LanguageCatalog.js";

/** What kind of thing a chunk is, structurally. */
export type StructuralRole = "definition" | "orchestration" | "implementation";

/** One enclosing scope, e.g. `class Foo`. */
export interface ScopeEntry {
	kind: string;
	name: string;
}

/**
 * Builds the context header prepended to a chunk before embedding.
 *
 * The header is what makes an isolated function retrievable: on its own,
 * `async function handle(req)` shares little vocabulary with "how are webhooks
 * authenticated", but stamped with its file, enclosing class and doc comment
 * it does. Retrieval quality depends on this at least as much as on the text.
 */
export class ChunkContextBuilder {
	/** How far above a node to look for its doc comment. */
	private static readonly MAX_COMMENT_LOOKBACK = 10;

	/** AST node type -> the word used for it in the header. */
	private static readonly SCOPE_KINDS: Record<string, string> = {
		// TypeScript / JavaScript
		class_declaration: "class",
		class_body: "class",
		interface_declaration: "interface",
		module: "module",
		namespace_declaration: "namespace",
		// Python
		class_definition: "class",
		// Rust
		impl_item: "impl",
		trait_item: "trait",
		mod_item: "mod",
		// Go
		type_declaration: "type",
		// Ruby
		class: "class",
		// C / C++
		struct_specifier: "struct",
		class_specifier: "class",
		namespace_definition: "namespace",
		// Swift
		struct_declaration: "struct",
		extension_declaration: "extension",
		// Scala
		object_definition: "object",
		trait_definition: "trait",
		// Generic
		ContainerDecl: "container",
	};

	/** Node types that declare a shape rather than behaviour. */
	private static readonly DEFINITION_TYPES = new Set([
		"class_declaration",
		"class_definition",
		"interface_declaration",
		"type_alias_declaration",
		"enum_declaration",
		"struct_item",
		"enum_item",
		"trait_item",
		"type_item",
		"type_declaration",
		"struct_specifier",
		"class_specifier",
		"enum_specifier",
		"type_definition",
		"struct_declaration",
		"protocol_declaration",
		"trait_definition",
		"ContainerDecl",
	]);

	/** Node types that wire things together rather than implement them. */
	private static readonly ORCHESTRATION_TYPES = new Set([
		"export_statement",
		"decorated_definition",
	]);

	/** The full header for one chunk. */
	build(
		node: Node,
		filePath: string,
		source: string,
		language: LanguageConfig,
	): string {
		const lines: string[] = [
			`[file: ${filePath}]`,
			`[role: ${this.classifyRole(node)}]`,
		];

		const scope = this.extractScope(node, language);
		if (scope.length > 0) {
			lines.push(
				`[scope: ${scope.map((s) => `${s.kind} ${s.name}`).join(" > ")}]`,
			);
		}

		const comment = this.extractLeadingComment(node, source);
		if (comment) lines.push(`[doc: ${comment}]`);

		return lines.join("\n");
	}

	/** The minimal header for a file with no parsed structure. */
	buildFileOnly(filePath: string): string {
		return `[file: ${filePath}]`;
	}

	/** Walk up from a node collecting the named scopes that enclose it. */
	extractScope(node: Node, language: LanguageConfig): ScopeEntry[] {
		const scopes: ScopeEntry[] = [];
		let current = node.parent;
		while (current) {
			if (language.scopeTypes.includes(current.type)) {
				const name = this.nodeName(current);
				if (name) {
					scopes.unshift({
						kind:
							ChunkContextBuilder.SCOPE_KINDS[current.type] ??
							current.type,
						name,
					});
				}
			}
			current = current.parent;
		}
		return scopes;
	}

	/**
	 * Collect the comment block or decorators immediately above a node.
	 *
	 * A blank line ends the block only once something has been collected, so a
	 * comment separated from its node by whitespace is still picked up, while
	 * unrelated code above it is not.
	 */
	extractLeadingComment(node: Node, source: string): string | null {
		const lines = source.split("\n");
		const start = node.startPosition.row;
		const collected: string[] = [];

		for (
			let i = start - 1;
			i >= 0 && i >= start - ChunkContextBuilder.MAX_COMMENT_LOOKBACK;
			i--
		) {
			const line = lines[i].trim();
			if (this.looksLikeCommentOrDecorator(line)) {
				collected.unshift(lines[i]);
			} else if (line === "") {
				if (collected.length > 0) break;
			} else {
				break;
			}
		}

		return collected.length === 0 ? null : collected.join("\n").trim();
	}

	classifyRole(node: Node): StructuralRole {
		if (ChunkContextBuilder.DEFINITION_TYPES.has(node.type)) {
			return "definition";
		}
		if (ChunkContextBuilder.ORCHESTRATION_TYPES.has(node.type)) {
			return "orchestration";
		}
		return "implementation";
	}

	/** Comment syntax across every supported language, plus decorators. */
	private looksLikeCommentOrDecorator(line: string): boolean {
		return (
			line.startsWith("//") ||
			line.startsWith("#") ||
			line.startsWith("*") ||
			line.startsWith("/*") ||
			line.startsWith("*/") ||
			line.startsWith("///") ||
			line.startsWith("--") ||
			line.startsWith("@") ||
			line.startsWith('"""') ||
			line.startsWith("'''")
		);
	}

	private nodeName(node: Node): string | undefined {
		return (
			node.childForFieldName("name") ??
			node.children.find(
				(c: Node) =>
					c.type === "identifier" || c.type === "type_identifier",
			)
		)?.text;
	}
}
