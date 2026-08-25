/**
 * The text an MCP client sees for each tool.
 *
 * These are prompts, not documentation: they are what decides whether an agent
 * reaches for lmgrep or falls back to grep, and they were tuned by watching
 * agents choose. Treat edits here as behaviour changes.
 */
export class ToolDescriptions {
	static readonly SEARCH_PARAMS = {
		query: {
			description:
				'Natural-language description of what you\'re looking for — phrase it as a question or intent, not keywords. Good: "how are webhooks authenticated", "where is user deletion handled", "what happens when a record is created". Bad: "webhook auth", "deleteUser", "createRecord".',
		},
		limit: {
			description: "Maximum number of results",
			default: 5,
		},
		filePrefix: {
			description: "Restrict to files under this path (e.g. 'src/lib')",
		},
		type: {
			description:
				"AST node types to filter by (e.g. ['function_declaration', 'class_declaration'])",
		},
		language: {
			description: "File extensions to filter by (e.g. ['.ts', '.py'])",
		},
		project: {
			description:
				"Search a different indexed project by its root path instead of the current one",
		},
	};

	static readonly LIST_PROJECTS =
		"List all indexed projects other than the current one. " +
		"Use this to discover what projects are available for cross-project search " +
		"via the `project` parameter on the search tool.";

	static readonly FACET = [
		"**Get a labeled overview of what *kinds* of code match a query, instead of raw results.** Returns 5 clusters, each with a one-word label, a handful of qualifier words describing that cluster's angle, and a size. No file paths, no chunks — just the shape of the result space.",
		"",
		"**Use facet when:**",
		"- The query is broad or exploratory (`auth`, `error handling`, `payment flow`).",
		"- You don't yet know the vocabulary the codebase uses for a concept — the qualifiers surface the real terms (e.g. `auth` → clusters revealing `fireauth`, `oauth`, `serviceaccount`).",
		"- A previous `search` returned a heterogeneous mix and you want to see why.",
		"",
		"**Do NOT use facet when:** the query is already specific (a symbol, a precise question, an error message). Call `search` directly.",
		"",
		'**How to act on the output:** pick the cluster that matches your intent, then call `search` with a narrower query that combines the original intent with the cluster\'s label + qualifiers (e.g. after `facet("auth")` returns a cluster `email: fireauth, phone, provider`, call `search("authentication with fireauth phone provider")`). This uses the corpus\'s own vocabulary and dramatically improves recall.',
	].join("\n");

	static readonly FACET_PARAM = {
		description:
			"Broad, natural-language query to faceted over. Same phrasing as `search`, but use when the query is exploratory and you want to see the categories of matching code.",
	};

	static readonly ASK_PARAM = {
		description:
			'The question to answer, in natural language — phrase it as a real question about the code. Good: "how does the file watcher trigger reindexing", "where are webhooks authenticated and what token format", "what happens when a user is deleted".',
	};

	static readonly ASK = [
		"**Ask a question about this codebase and get back a synthesized, cited answer** — instead of raw search results you have to read yourself. A local model runs a short research loop (searches the index, reads the matching code, writes a grounded answer), so you spend one tool call and a paragraph instead of several searches and pages of chunks.",
		"",
		'**Use `ask` when you want a question *answered*:** "how does X work", "where is Y handled and what does it do", "what happens when Z", "how do these pieces fit together". The retrieval loop runs on a local model — cheap on your context.',
		"",
		"**Use `search` instead when you want the raw code** to read yourself (exact snippets, or to browse many hits). `ask` complements `search`; it does not replace it.",
		"",
		"**Every claim is cited** as `[n]` → `file:line`, listed under the answer, so you can verify or open the sources. If an answer looks off or thin, fall back to `search` for the raw chunks.",
		"",
		"**Tradeoff:** `ask` runs a local model, so it's slower than `search` — roughly ~10s to a couple of minutes depending on the question and hardware — but it does the searching and reading for you.",
	].join("\n");

	/** Shown while search is working. */
	static readonly SEARCH_HEALTHY = [
		"**lmgrep — primary search tool for this codebase.** Semantic code search powered by a local embedding model; lmgrep understands intent, not string patterns. Prefer lmgrep over Grep/Glob/find/ripgrep for almost all exploration and lookup tasks.",
		"",
		'**Use lmgrep for:** finding where something is handled, how something works, locating relevant code, discovering related files, understanding unfamiliar code, tracing side effects, finding usage patterns, answering "where is X?" or "how does Y work?". One good lmgrep query is usually enough to understand how to proceed.',
		"",
		"**Query lmgrep as natural questions or intent descriptions**, not keyword dumps:",
		'- "how are webhooks authenticated" → finds middleware, token validation, auth checks',
		'- "where is user deletion handled" → finds the handler and related cleanup logic',
		'- "what happens when a record is created" → finds controllers, event emitters, side effects',
		'- "config loading and validation"',
		'- "how to run the playwright tests" → finds config, scripts, prerequisites',
		"",
		"**lmgrep results include** file paths, line numbers, AST node types, and surrounding context (scope, leading comments, role) — often enough to act on directly without re-reading the file. Trust lmgrep results; don't follow up with Glob/Read on files already surfaced by lmgrep unless you genuinely need content that wasn't returned.",
		"",
		"**Fall back to Grep only** when you need exact string or regex matches (specific identifiers, literal constants, error messages, TODO markers). Don't use Grep/Glob/find for conceptual or intent-based search — lmgrep will do better.",
	].join("\n");

	/** Shown when search is unavailable, explaining why and what still works. */
	static unavailable(
		reason: "not_indexed" | "embedding_failed" | "search_empty" | "ok",
		otherProjectsAvailable: boolean,
	): string {
		const suffix = otherProjectsAvailable
			? " You can still search other indexed projects via the `project` parameter — call `list_other_indexed_projects` to see what's available."
			: "";

		switch (reason) {
			case "not_indexed":
				return (
					"This project is not indexed. Semantic search is not available for the current directory." +
					suffix
				);
			case "embedding_failed":
				return (
					"The embedding provider is unreachable. Semantic search is temporarily unavailable for the current directory." +
					suffix
				);
			case "search_empty":
				return (
					"The index for the current branch appears empty or stale — a smoke query returned no results. Re-run `lmgrep index` to rebuild." +
					suffix
				);
			default:
				return `Semantic search is unavailable.${suffix}`;
		}
	}

	static readonly EMBEDDER_DOWN =
		"lmgrep is unavailable: the embedding provider is unreachable. Ask the user to check their lmgrep configuration (`lmgrep status`) before retrying.";
}
