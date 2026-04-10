import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type LanguageId =
	| "javascript"
	| "typescript"
	| "tsx"
	| "python"
	| "rust"
	| "go"
	| "ruby"
	| "c"
	| "cpp"
	| "swift"
	| "json"
	| "yaml"
	| "toml"
	| "lua"
	| "scala"
	| "zig"
	| "bash"
	| "html"
	| "css"
	| "java"
	| "kotlin"
	| "php"
	| "c_sharp"
	| "vue";

export interface LanguageConfig {
	id: LanguageId;
	extensions: string[];
	wasmFile: string;
	/** AST node types that represent top-level or nestable definitions */
	chunkTypes: string[];
	/** AST node types that represent import/require statements */
	importTypes: string[];
	/** AST node types that represent class/struct/module wrappers */
	scopeTypes: string[];
}

export const LANGUAGES: LanguageConfig[] = [
	{
		id: "javascript",
		extensions: [".js", ".jsx"],
		wasmFile: "tree-sitter-javascript.wasm",
		chunkTypes: [
			"function_declaration",
			"arrow_function",
			"method_definition",
			"class_declaration",
			"export_statement",
			"variable_declarator",
		],
		importTypes: ["import_statement", "call_expression"],
		scopeTypes: ["class_declaration", "class_body"],
	},
	{
		id: "typescript",
		extensions: [".ts"],
		wasmFile: "tree-sitter-typescript.wasm",
		chunkTypes: [
			"function_declaration",
			"arrow_function",
			"method_definition",
			"class_declaration",
			"interface_declaration",
			"type_alias_declaration",
			"enum_declaration",
			"export_statement",
			"variable_declarator",
		],
		importTypes: ["import_statement"],
		scopeTypes: [
			"class_declaration",
			"interface_declaration",
			"module",
			"namespace_declaration",
		],
	},
	{
		id: "tsx",
		extensions: [".tsx"],
		wasmFile: "tree-sitter-tsx.wasm",
		chunkTypes: [
			"function_declaration",
			"arrow_function",
			"method_definition",
			"class_declaration",
			"interface_declaration",
			"type_alias_declaration",
			"enum_declaration",
			"export_statement",
			"variable_declarator",
		],
		importTypes: ["import_statement"],
		scopeTypes: [
			"class_declaration",
			"interface_declaration",
			"module",
			"namespace_declaration",
		],
	},
	{
		id: "python",
		extensions: [".py"],
		wasmFile: "tree-sitter-python.wasm",
		chunkTypes: [
			"function_definition",
			"class_definition",
			"decorated_definition",
		],
		importTypes: ["import_statement", "import_from_statement"],
		scopeTypes: ["class_definition", "module"],
	},
	{
		id: "rust",
		extensions: [".rs"],
		wasmFile: "tree-sitter-rust.wasm",
		chunkTypes: [
			"function_item",
			"impl_item",
			"struct_item",
			"enum_item",
			"trait_item",
			"type_item",
			"const_item",
			"static_item",
			"macro_definition",
		],
		importTypes: ["use_declaration"],
		scopeTypes: ["impl_item", "trait_item", "mod_item"],
	},
	{
		id: "go",
		extensions: [".go"],
		wasmFile: "tree-sitter-go.wasm",
		chunkTypes: [
			"function_declaration",
			"method_declaration",
			"type_declaration",
			"const_declaration",
			"var_declaration",
		],
		importTypes: ["import_declaration"],
		scopeTypes: ["type_declaration"],
	},
	{
		id: "ruby",
		extensions: [".rb"],
		wasmFile: "tree-sitter-ruby.wasm",
		chunkTypes: ["method", "singleton_method", "class", "module"],
		importTypes: ["call"],
		scopeTypes: ["class", "module"],
	},
	{
		id: "c",
		extensions: [".c", ".h"],
		wasmFile: "tree-sitter-c.wasm",
		chunkTypes: [
			"function_definition",
			"struct_specifier",
			"enum_specifier",
			"type_definition",
			"declaration",
		],
		importTypes: ["preproc_include"],
		scopeTypes: ["struct_specifier"],
	},
	{
		id: "cpp",
		extensions: [".cpp", ".hpp", ".cc"],
		wasmFile: "tree-sitter-cpp.wasm",
		chunkTypes: [
			"function_definition",
			"class_specifier",
			"struct_specifier",
			"namespace_definition",
			"template_declaration",
			"enum_specifier",
		],
		importTypes: ["preproc_include", "using_declaration"],
		scopeTypes: [
			"class_specifier",
			"struct_specifier",
			"namespace_definition",
		],
	},
	{
		id: "swift",
		extensions: [".swift"],
		wasmFile: "tree-sitter-swift.wasm",
		chunkTypes: [
			"function_declaration",
			"class_declaration",
			"struct_declaration",
			"enum_declaration",
			"protocol_declaration",
			"extension_declaration",
		],
		importTypes: ["import_declaration"],
		scopeTypes: [
			"class_declaration",
			"struct_declaration",
			"extension_declaration",
		],
	},
	{
		id: "json",
		extensions: [".json"],
		wasmFile: "tree-sitter-json.wasm",
		chunkTypes: ["pair"],
		importTypes: [],
		scopeTypes: ["object"],
	},
	{
		id: "yaml",
		extensions: [".yaml", ".yml"],
		wasmFile: "tree-sitter-yaml.wasm",
		chunkTypes: ["block_mapping_pair"],
		importTypes: [],
		scopeTypes: ["block_mapping"],
	},
	{
		id: "toml",
		extensions: [".toml"],
		wasmFile: "tree-sitter-toml.wasm",
		chunkTypes: ["table", "pair"],
		importTypes: [],
		scopeTypes: ["table"],
	},
	{
		id: "lua",
		extensions: [".lua"],
		wasmFile: "tree-sitter-lua.wasm",
		chunkTypes: [
			"function_declaration",
			"local_function",
			"function_definition",
		],
		importTypes: ["call"],
		scopeTypes: [],
	},
	{
		id: "scala",
		extensions: [".scala"],
		wasmFile: "tree-sitter-scala.wasm",
		chunkTypes: [
			"function_definition",
			"val_definition",
			"var_definition",
			"class_definition",
			"object_definition",
			"trait_definition",
		],
		importTypes: ["import_declaration"],
		scopeTypes: [
			"class_definition",
			"object_definition",
			"trait_definition",
		],
	},
	{
		id: "zig",
		extensions: [".zig"],
		wasmFile: "tree-sitter-zig.wasm",
		chunkTypes: ["FnProto", "VarDecl", "ContainerDecl", "TestDecl"],
		importTypes: [],
		scopeTypes: ["ContainerDecl"],
	},
	{
		id: "bash",
		extensions: [".sh", ".bash"],
		wasmFile: "tree-sitter-bash.wasm",
		chunkTypes: ["function_definition"],
		importTypes: ["command"],
		scopeTypes: [],
	},
	{
		id: "html",
		extensions: [".html"],
		wasmFile: "tree-sitter-html.wasm",
		chunkTypes: ["element", "script_element", "style_element"],
		importTypes: [],
		scopeTypes: ["element"],
	},
	{
		id: "css",
		extensions: [".css", ".scss"],
		wasmFile: "tree-sitter-css.wasm",
		chunkTypes: ["rule_set", "media_statement", "keyframes_statement"],
		importTypes: ["import_statement"],
		scopeTypes: [],
	},
	{
		id: "java",
		extensions: [".java"],
		wasmFile: "tree-sitter-java.wasm",
		chunkTypes: [
			"class_declaration",
			"interface_declaration",
			"enum_declaration",
			"method_declaration",
			"constructor_declaration",
			"record_declaration",
		],
		importTypes: ["import_declaration"],
		scopeTypes: ["class_declaration", "interface_declaration"],
	},
	{
		id: "kotlin",
		extensions: [".kt"],
		wasmFile: "tree-sitter-kotlin.wasm",
		chunkTypes: [
			"class_declaration",
			"object_declaration",
			"function_declaration",
			"property_declaration",
		],
		importTypes: ["import_header"],
		scopeTypes: ["class_declaration", "object_declaration"],
	},
	{
		id: "php",
		extensions: [".php"],
		wasmFile: "tree-sitter-php.wasm",
		chunkTypes: [
			"class_declaration",
			"interface_declaration",
			"trait_declaration",
			"enum_declaration",
			"function_definition",
			"method_declaration",
		],
		importTypes: ["namespace_use_declaration"],
		scopeTypes: [
			"class_declaration",
			"interface_declaration",
			"trait_declaration",
		],
	},
	{
		id: "c_sharp",
		extensions: [".cs"],
		wasmFile: "tree-sitter-c_sharp.wasm",
		chunkTypes: [
			"class_declaration",
			"interface_declaration",
			"struct_declaration",
			"enum_declaration",
			"record_declaration",
			"method_declaration",
			"constructor_declaration",
			"property_declaration",
		],
		importTypes: ["using_directive"],
		scopeTypes: [
			"class_declaration",
			"interface_declaration",
			"struct_declaration",
			"namespace_declaration",
		],
	},
	{
		id: "vue",
		extensions: [".vue"],
		wasmFile: "tree-sitter-vue.wasm",
		chunkTypes: ["script_element", "template_element", "style_element"],
		importTypes: [],
		scopeTypes: [],
	},
];

const extToLang = new Map<string, LanguageConfig>();
for (const lang of LANGUAGES) {
	for (const ext of lang.extensions) {
		extToLang.set(ext, lang);
	}
}

export function getLanguageForFile(
	filePath: string,
): LanguageConfig | undefined {
	const ext = filePath.slice(filePath.lastIndexOf("."));
	return extToLang.get(ext);
}

export function getWasmPath(lang: LanguageConfig): string | undefined {
	try {
		return require.resolve(`tree-sitter-wasms/out/${lang.wasmFile}`);
	} catch {
		return undefined;
	}
}
