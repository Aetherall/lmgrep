import type Parser from "web-tree-sitter";
import type { LanguageConfig } from "./languages.js";

export type StructuralRole = "definition" | "orchestration" | "implementation";

export interface ScopeEntry {
	kind: string;
	name: string;
}

export interface ChunkContext {
	filePath: string;
	scope: ScopeEntry[];
	leadingComment: string | null;
	role: StructuralRole;
}

const SCOPE_KIND_MAP: Record<string, string> = {
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

const DEFINITION_TYPES = new Set([
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

const ORCHESTRATION_TYPES = new Set([
	"export_statement",
	"decorated_definition",
]);

/** Walk up from a node to collect typed parent scopes */
export function extractScope(
	node: Parser.SyntaxNode,
	langConfig: LanguageConfig,
): ScopeEntry[] {
	const scopes: ScopeEntry[] = [];
	let current = node.parent;
	while (current) {
		if (langConfig.scopeTypes.includes(current.type)) {
			const name = extractNodeName(current);
			if (name) {
				const kind = SCOPE_KIND_MAP[current.type] ?? current.type;
				scopes.unshift({ kind, name });
			}
		}
		current = current.parent;
	}
	return scopes;
}

/** Extract leading comments and decorators immediately before a node */
export function extractLeadingComment(
	node: Parser.SyntaxNode,
	source: string,
): string | null {
	const lines = source.split("\n");
	const nodeStartLine = node.startPosition.row;
	const collected: string[] = [];

	for (let i = nodeStartLine - 1; i >= 0 && i >= nodeStartLine - 10; i--) {
		const line = lines[i].trim();
		if (
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
		) {
			collected.unshift(lines[i]);
		} else if (line === "") {
			if (collected.length > 0) break;
		} else {
			break;
		}
	}

	if (collected.length === 0) return null;
	return collected.join("\n").trim();
}

/** Classify a chunk's structural role based on its AST node type */
export function classifyRole(node: Parser.SyntaxNode): StructuralRole {
	if (DEFINITION_TYPES.has(node.type)) return "definition";
	if (ORCHESTRATION_TYPES.has(node.type)) return "orchestration";
	return "implementation";
}

/** Build the context prefix string for a chunk */
export function buildContextString(ctx: ChunkContext): string {
	const lines: string[] = [];

	lines.push(`[file: ${ctx.filePath}]`);
	lines.push(`[role: ${ctx.role}]`);

	if (ctx.scope.length > 0) {
		const scopeStr = ctx.scope
			.map((s) => `${s.kind} ${s.name}`)
			.join(" > ");
		lines.push(`[scope: ${scopeStr}]`);
	}

	if (ctx.leadingComment) {
		lines.push(`[doc: ${ctx.leadingComment}]`);
	}

	return lines.join("\n");
}

function extractNodeName(node: Parser.SyntaxNode): string | undefined {
	const nameNode =
		node.childForFieldName("name") ??
		node.children.find(
			(c: Parser.SyntaxNode) =>
				c.type === "identifier" || c.type === "type_identifier",
		);
	return nameNode?.text;
}
