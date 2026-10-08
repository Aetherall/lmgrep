import type { Hit } from "../domain/retrieval/Hit.js";

export class HitPresentation {
	static readonly MAX_LINES = 80;
	static readonly MAX_CHARACTERS = 16_000;
	private static readonly MAX_CONTEXT_LINES = 12;

	static format(hit: Hit): string {
		const notices: string[] = [];
		const context = HitPresentation.context(hit.context);
		const shownContext = context.slice(0, HitPresentation.MAX_CONTEXT_LINES);
		if (context.length > shownContext.length) {
			const notice = `… ${context.length - shownContext.length} context lines omitted (${HitPresentation.location(String(hit.location))})`;
			shownContext.push(notice);
			notices.push(notice);
		}
		const source = hit.content === "" ? [] : hit.content.split(/\r?\n/);
		if (
			source.at(-1) === "" &&
			source.length > hit.location.endLine - hit.location.startLine + 1
		) {
			source.pop();
		}
		const available = HitPresentation.MAX_LINES - 1 - shownContext.length;
		const shown = source.length > available ? available - 1 : source.length;
		const width = String(hit.location.startLine + source.length - 1).length;
		const lines = [
			`${hit.location} · ${HitPresentation.symbol(hit)} [${HitPresentation.kind(hit.type)}] (score: ${hit.score.toFixed(3)})`,
			...shownContext,
			...source.slice(0, shown).map((line, index) => {
				const number = String(hit.location.startLine + index).padStart(width);
				return `${number} | ${line}`;
			}),
		];
		if (shown < source.length) {
			const notice = `… ${source.length - shown} source lines omitted (${HitPresentation.location(`${hit.location.filePath}:${hit.location.startLine + shown}-${hit.location.startLine + source.length - 1}`)})`;
			lines.push(notice);
			notices.push(notice);
		}
		return HitPresentation.limitCharacters(lines, hit, notices);
	}

	private static location(value: string): string {
		return value.length <= 200
			? value
			: `${value.slice(0, 200)}… (${value.length - 200} location characters omitted)`;
	}

	private static limitCharacters(
		lines: string[],
		hit: Hit,
		notices: string[],
	): string {
		const text = lines.join("\n");
		if (text.length <= HitPresentation.MAX_CHARACTERS) return text;
		const bodyLines = lines.filter((line) => !notices.includes(line));
		const body = bodyLines.join("\n");
		const location = HitPresentation.location(String(hit.location));
		const reserved = [
			`… ${body.length} output characters omitted (${location})`,
			...notices,
		].join("\n");
		let prefix = bodyLines
			.slice(0, HitPresentation.MAX_LINES - notices.length - 1)
			.join("\n")
			.slice(0, HitPresentation.MAX_CHARACTERS - reserved.length - 1);
		if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
		return [
			prefix,
			`… ${body.length - prefix.length} output characters omitted (${location})`,
			...notices,
		].join("\n");
	}

	private static context(value: string): string[] {
		return value
			.replace(/^\[(?:file|role|symbol):[^\r\n]*\]\r?\n?/gm, "")
			.replace(
				/^\[(scope|doc): ([\s\S]*?)\](?=\r?\n\[|\s*$)/gm,
				(_, key, text) => `${key === "scope" ? "Scope" : "Doc"}: ${text}`,
			)
			.trim()
			.split(/\r?\n/)
			.filter((line) => line !== "");
	}

	private static symbol(hit: Hit): string {
		if (
			hit.name.trim() &&
			!/^(?:anonymous(?:_\d+)?|lines_\d+(?:_\d+)?)$/.test(hit.name)
		) {
			return hit.name.replace(/\s+/g, " ").trim();
		}
		const signature =
			hit.content
				.split(/\r?\n/)
				.find((line) => line.trim() && !line.trimStart().startsWith("@")) ?? "";
		const declaration = signature.match(
			/^\s*(?:(?:export|default|async|pub(?:\([^)]*\))?)\s+)*(?:function\s*\*?|def|class|interface|enum|struct|trait|type|fn|func)\s+([\w$]+)/,
		);
		const binding = signature.match(
			/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)/,
		);
		const name = declaration?.[1] ?? binding?.[1];
		if (name) return name;
		if (/^(?:file|text|window|chunk|block|section)$/.test(hit.type)) {
			return hit.location.filePath.split("/").at(-1) ?? hit.location.filePath;
		}
		return "(unnamed)";
	}

	private static kind(type: string): string {
		const aliases: Record<string, string> = {
			arrow_function: "function",
			decorated_definition: "decorated definition",
			export_statement: "export",
			variable_declarator: "variable",
			type_alias_declaration: "type alias",
			singleton_method: "class method",
			impl_item: "implementation",
			const_item: "constant",
			const_declaration: "constant",
			var_declaration: "variable",
			mod_item: "module",
			text: "text",
			window: "text window",
			ContainerDecl: "container",
			FnProto: "function",
			FnDecl: "function",
			VarDecl: "variable",
		};
		return (
			aliases[type] ??
			type
				.replace(/_(?:declaration|definition|item|specifier)$/, "")
				.replace(/_/g, " ")
		);
	}
}
