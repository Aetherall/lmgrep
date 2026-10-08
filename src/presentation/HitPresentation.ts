import type { Hit } from "../domain/retrieval/Hit.js";

export class HitPresentation {
	static readonly MAX_LINES = 80;
	static readonly MAX_CHARACTERS = 16_000;
	private static readonly MAX_CONTEXT_LINES = 12;

	static cards(hits: readonly Hit[], classContext = false): string[] {
		const groups = new Map<string, Hit[]>();
		for (const hit of hits) {
			const owner = HitPresentation.owner(hit);
			const key = JSON.stringify([
				hit.location.filePath,
				hit.fileVersion.toStored(),
				owner ?? hit.id,
				owner === undefined,
			]);
			const group = groups.get(key);
			if (group) {
				if (!group.some((previous) => previous.id === hit.id)) group.push(hit);
			} else {
				groups.set(key, [hit]);
			}
		}
		const cards = [...groups.values()]
			.flatMap((group) => {
				const members = group.filter(
					(hit) => !HitPresentation.isContainer(hit),
				);
				const repeatedMember =
					new Set(members.map((hit) => hit.name)).size !== members.length;
				const declarations = group.filter(
					(hit) =>
						HitPresentation.isContainer(hit) &&
						/^\s*(?:(?:export|default|public|abstract|final|sealed)\s+)*(?:class|struct|interface|impl|trait|object)\b/m.test(
							hit.content,
						),
				);
				return repeatedMember || declarations.length > 1
					? group.map((hit) => [hit])
					: [group];
			})
			.sort((a, b) => hits.indexOf(a[0]) - hits.indexOf(b[0]));
		return cards.map(([primary, ...related]) => {
			const details = HitPresentation.classContext(
				primary,
				related,
				classContext,
			);
			return HitPresentation.format(primary, details);
		});
	}

	private static owner(hit: Hit): string | undefined {
		const scope = hit.context.match(/^\[scope: (.+)\]$/m)?.[1];
		if (
			HitPresentation.isContainer(hit) &&
			!/^(?:anonymous_|lines_)/.test(hit.name)
		) {
			return hit.name;
		}
		const scopes = scope?.split(" > ");
		if (
			!scopes?.some((entry) =>
				/^(?:class|struct|interface|trait|impl|object) /.test(entry),
			)
		) {
			return undefined;
		}
		return scopes.map((entry) => entry.replace(/^\S+ /, "")).join(".");
	}

	private static isContainer(hit: Hit): boolean {
		return [
			"class_declaration",
			"class_definition",
			"class_specifier",
			"struct_specifier",
			"struct_declaration",
			"impl_item",
			"trait_item",
			"trait_definition",
			"object_definition",
			"interface_declaration",
		].includes(hit.type);
	}

	private static classContext(
		primary: Hit,
		related: readonly Hit[],
		includeContext: boolean,
	): string[] {
		const details: string[] = [];
		const declaration = related.find((hit) => HitPresentation.isContainer(hit));
		const showDeclaration =
			includeContext && declaration && !HitPresentation.isContainer(primary);
		if (showDeclaration) {
			details.push(
				`Class: ${HitPresentation.brief(declaration.name)} · ${HitPresentation.location(String(declaration.location))}`,
			);
			const firstLine = declaration.content
				.split(/\r?\n/)
				.find((line) => line.trim());
			if (firstLine)
				details.push(
					`Declaration/state: ${HitPresentation.brief(firstLine.trim())}`,
				);
			const doc = declaration.context.match(
				/^\[doc: ([\s\S]*?)\](?=\r?\n\[|\s*$)/m,
			)?.[1];
			if (doc) {
				details.push(
					`Class doc: ${HitPresentation.brief(doc.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/|#)\s?/gm, "").replace(/\s*\*\/\s*$/, ""))}`,
				);
			}
		}
		const other = related.filter((hit) => !HitPresentation.isContainer(hit));
		for (const hit of other.slice(0, 3)) {
			details.push(
				`Related: ${HitPresentation.brief(HitPresentation.symbol(hit))} · ${HitPresentation.location(String(hit.location))}`,
			);
		}
		const omitted =
			related.length - other.slice(0, 3).length - (showDeclaration ? 1 : 0);
		if (omitted > 0)
			details.push(
				`… ${omitted} additional class matches omitted${includeContext ? "" : " (class context available)"}`,
			);
		return details;
	}

	private static brief(value: string): string {
		const text = value.replace(/\s+/g, " ").trim();
		return text.length <= 200
			? text
			: `${text.slice(0, 200)}… (${text.length - 200} characters omitted)`;
	}

	static format(hit: Hit, details: readonly string[] = []): string {
		const notices: string[] = [...details];
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
		const available =
			HitPresentation.MAX_LINES - 1 - shownContext.length - details.length;
		const capacity = HitPresentation.isContainer(hit)
			? Math.min(available, 12)
			: available;
		const shown = source.length > capacity ? capacity - 1 : source.length;
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
		lines.push(...details);
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
