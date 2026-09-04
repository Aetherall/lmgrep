import bash from "@lumis-sh/wasm-bash/tree-sitter-bash.wasm" with {
	type: "file",
};
import c from "@lumis-sh/wasm-c/tree-sitter-c.wasm" with { type: "file" };
import cpp from "@lumis-sh/wasm-cpp/tree-sitter-cpp.wasm" with { type: "file" };
import csharp from "@lumis-sh/wasm-csharp/tree-sitter-csharp.wasm" with {
	type: "file",
};
import css from "@lumis-sh/wasm-css/tree-sitter-css.wasm" with { type: "file" };
import go from "@lumis-sh/wasm-go/tree-sitter-go.wasm" with { type: "file" };
import html from "@lumis-sh/wasm-html/tree-sitter-html.wasm" with {
	type: "file",
};
import java from "@lumis-sh/wasm-java/tree-sitter-java.wasm" with {
	type: "file",
};
import javascript from "@lumis-sh/wasm-javascript/tree-sitter-javascript.wasm" with {
	type: "file",
};
import json from "@lumis-sh/wasm-json/tree-sitter-json.wasm" with {
	type: "file",
};
import kotlin from "@lumis-sh/wasm-kotlin/tree-sitter-kotlin.wasm" with {
	type: "file",
};
import lua from "@lumis-sh/wasm-lua/tree-sitter-lua.wasm" with { type: "file" };
import markdown from "@lumis-sh/wasm-markdown/tree-sitter-markdown.wasm" with {
	type: "file",
};
import nix from "@lumis-sh/wasm-nix/tree-sitter-nix.wasm" with { type: "file" };
import php from "@lumis-sh/wasm-php/tree-sitter-php.wasm" with { type: "file" };
import python from "@lumis-sh/wasm-python/tree-sitter-python.wasm" with {
	type: "file",
};
import ruby from "@lumis-sh/wasm-ruby/tree-sitter-ruby.wasm" with {
	type: "file",
};
import rust from "@lumis-sh/wasm-rust/tree-sitter-rust.wasm" with {
	type: "file",
};
import scala from "@lumis-sh/wasm-scala/tree-sitter-scala.wasm" with {
	type: "file",
};
import swift from "@lumis-sh/wasm-swift/tree-sitter-swift.wasm" with {
	type: "file",
};
import toml from "@lumis-sh/wasm-toml/tree-sitter-toml.wasm" with {
	type: "file",
};
import tsx from "@lumis-sh/wasm-tsx/tree-sitter-tsx.wasm" with { type: "file" };
import typescript from "@lumis-sh/wasm-typescript/tree-sitter-typescript.wasm" with {
	type: "file",
};
import vue from "@lumis-sh/wasm-vue/tree-sitter-vue.wasm" with { type: "file" };
import yaml from "@lumis-sh/wasm-yaml/tree-sitter-yaml.wasm" with {
	type: "file",
};
import zig from "@lumis-sh/wasm-zig/tree-sitter-zig.wasm" with { type: "file" };
import parserWasm from "web-tree-sitter/web-tree-sitter.wasm" with {
	type: "file",
};
import { registerEmbeddedTreeSitterAssets } from "../src/infrastructure/treesitter/EmbeddedTreeSitterAssets.js";

registerEmbeddedTreeSitterAssets({
	parser: parserWasm,
	grammars: {
		"tree-sitter-bash.wasm": bash,
		"tree-sitter-c.wasm": c,
		"tree-sitter-cpp.wasm": cpp,
		"tree-sitter-csharp.wasm": csharp,
		"tree-sitter-css.wasm": css,
		"tree-sitter-go.wasm": go,
		"tree-sitter-html.wasm": html,
		"tree-sitter-java.wasm": java,
		"tree-sitter-javascript.wasm": javascript,
		"tree-sitter-json.wasm": json,
		"tree-sitter-kotlin.wasm": kotlin,
		"tree-sitter-lua.wasm": lua,
		"tree-sitter-markdown.wasm": markdown,
		"tree-sitter-nix.wasm": nix,
		"tree-sitter-php.wasm": php,
		"tree-sitter-python.wasm": python,
		"tree-sitter-ruby.wasm": ruby,
		"tree-sitter-rust.wasm": rust,
		"tree-sitter-scala.wasm": scala,
		"tree-sitter-swift.wasm": swift,
		"tree-sitter-toml.wasm": toml,
		"tree-sitter-tsx.wasm": tsx,
		"tree-sitter-typescript.wasm": typescript,
		"tree-sitter-vue.wasm": vue,
		"tree-sitter-yaml.wasm": yaml,
		"tree-sitter-zig.wasm": zig,
	},
});

await import("../src/cli.js");
