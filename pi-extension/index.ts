import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLmgrepCore, type HealthState } from "../src/lib/search-tool.ts";

const SEARCH_TOOL = "lmgrep_search";
const LIST_TOOL = "lmgrep_list_other_indexed_projects";
const LMGREP_TOOLS = [SEARCH_TOOL, LIST_TOOL];

function shouldShowTools(state: HealthState): boolean {
	return state.reason !== "embedding_failed";
}

export default async function (pi: ExtensionAPI) {
	let core: Awaited<ReturnType<typeof createLmgrepCore>>;
	try {
		core = await createLmgrepCore({ cwd: process.cwd() });
	} catch {
		// No config, broken config, or index open failure — stay silent.
		// The user should run `lmgrep init` / `lmgrep index` in their terminal.
		return;
	}

	pi.registerTool({
		name: SEARCH_TOOL,
		label: "lmgrep",
		description: core.buildSearchDescription(),
		parameters: Type.Object({
			query: Type.String({ description: core.searchParams.query.description }),
			limit: Type.Optional(
				Type.Number({
					description: core.searchParams.limit.description,
					minimum: 1,
				}),
			),
			filePrefix: Type.Optional(
				Type.String({ description: core.searchParams.filePrefix.description }),
			),
			type: Type.Optional(
				Type.Array(Type.String(), {
					description: core.searchParams.type.description,
				}),
			),
			language: Type.Optional(
				Type.Array(Type.String(), {
					description: core.searchParams.language.description,
				}),
			),
			project: Type.Optional(
				Type.String({ description: core.searchParams.project.description }),
			),
		}),

		async execute(_toolCallId, params) {
			const result = await core.executeSearch(params);
			if (result.isError) throw new Error(result.text);
			return { content: [{ type: "text", text: result.text }] };
		},
	});

	pi.registerTool({
		name: LIST_TOOL,
		label: "lmgrep projects",
		description: core.listProjectsDescription,
		parameters: Type.Object({}),
		async execute() {
			const result = await core.executeListProjects();
			return { content: [{ type: "text", text: result.text }] };
		},
	});

	function gateActiveTools(state: HealthState): void {
		const active = new Set(pi.getActiveTools());
		const show = shouldShowTools(state);
		let changed = false;
		for (const name of LMGREP_TOOLS) {
			if (show && !active.has(name)) {
				active.add(name);
				changed = true;
			} else if (!show && active.has(name)) {
				active.delete(name);
				changed = true;
			}
		}
		if (changed) pi.setActiveTools([...active]);
	}

	pi.on("session_start", () => {
		core.startHealthLoop();
		gateActiveTools(core.currentHealth());
	});

	core.onHealthChange((state) => {
		gateActiveTools(state);
	});

	pi.on("session_shutdown", async () => {
		await core.dispose();
	});
}
