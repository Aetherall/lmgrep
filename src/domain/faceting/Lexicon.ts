import { stemmer } from "stemmer";

/**
 * The lexical side of faceting: turning source text into candidate vocabulary
 * terms. Pure text processing — no vectors, no clustering.
 */
export class Lexicon {
	private static readonly STOPWORDS = new Set([
		// English
		"the", "and", "but", "are", "was", "were", "been", "being",
		"have", "has", "had", "does", "did", "will", "would", "could", "should",
		"may", "might", "must", "can", "this", "that", "these", "those",
		"what", "which", "who", "when", "where", "why", "how",
		"all", "each", "every", "both", "few", "more", "most", "other", "some",
		"such", "nor", "not", "only", "own", "same", "than", "too", "very",
		"just", "don", "now", "else", "for", "with", "from", "into", "out",
		"off", "over", "under", "again", "further", "then", "once", "here",
		"there", "any", "about", "after", "before", "between", "during", "while",
		"because", "although", "though", "unless", "until", "since", "through",
		"against", "toward", "within", "without", "across", "around", "behind",
		"below", "above", "among", "beside", "besides", "beyond", "despite",
		"however", "therefore", "otherwise", "likely", "perhaps", "probably",
		"maybe", "really", "actually", "certainly", "surely", "basically",
		"generally", "usually", "typically", "often", "sometimes", "rarely",
		"always", "never", "anymore", "anyway", "anyways", "anytime", "anywhere",
		"looks", "seems", "means", "making", "taking", "going", "coming",
		"getting", "doing", "being", "having", "saying", "seeing", "knowing",
		"using", "trying", "showing", "giving", "telling", "thinking", "working",
		"calling", "letting", "putting", "holding", "running", "keeping",
		// Generic code
		"return", "const", "let", "var", "function", "async", "await", "new",
		"import", "export", "default", "public", "private", "protected", "class",
		"interface", "type", "extends", "implements", "static", "readonly", "void",
		"null", "undefined", "true", "false", "string", "number", "boolean",
		"object", "array", "promise", "unknown", "never", "typeof", "keyof",
		"satisfies", "args", "opts", "option", "options", "props", "params",
		"param", "data", "value", "values", "items", "item", "list", "index",
		"idx", "err", "error", "result", "results", "callback", "handler",
		"anonymous", "lines", "context", "payload", "input", "output", "arg",
		"self", "this", "that", "super", "constructor", "prototype", "instance",
		"method", "methods", "field", "fields", "key", "keys", "entry", "entries",
		"name", "names", "count", "size", "length", "total", "sum", "min", "max",
		"temp", "tmp", "foo", "bar", "baz", "qux", "test", "tests", "spec",
		"specs", "todo", "fixme", "hack", "note", "notes", "info",
		"loading", "loaded", "fetching", "fetched", "saving", "saved", "updating",
		"updated", "creating", "created", "deleting", "deleted", "removing",
		"removed", "parsing", "parsed", "building", "built", "processing",
		"processed", "running", "starting", "started", "stopping", "stopped",
		"setting", "getting", "adding", "added", "removing", "removed",
		"pending", "ready", "done", "ongoing", "complete", "completed",
	]);

	/**
	 * Split text into vocab terms. camelCase / snake_case / kebab-case
	 * identifiers are broken into parts. Stopwords, digits and length outliers
	 * are dropped.
	 */
	tokenize(text: string): string[] {
		if (!text) return [];
		const raw = text
			.replace(/[^A-Za-z0-9_]+/g, " ")
			.split(/\s+/)
			.filter(Boolean);
		const out: string[] = [];
		for (const t of raw) {
			const looksIdent = /[a-z][A-Z]|[A-Z]{2,}[a-z]|_/.test(t);
			const parts = looksIdent
				? this.splitIdentifier(t)
				: [t.toLowerCase()];
			for (const p of parts) {
				if (!this.isAcceptable(p)) continue;
				out.push(p);
			}
		}
		return out;
	}

	/**
	 * Document frequency of every term across `texts` — a term counts once per
	 * text however often it occurs there. Terms below `minDf` are dropped.
	 */
	collectVocabulary(
		texts: Iterable<string>,
		{ minDf = 1 }: { minDf?: number } = {},
	): Map<string, number> {
		const counts = new Map<string, number>();
		for (const t of texts) {
			const seen = new Set<string>();
			for (const tok of this.tokenize(t)) {
				if (!seen.has(tok)) {
					counts.set(tok, (counts.get(tok) ?? 0) + 1);
					seen.add(tok);
				}
			}
		}
		if (minDf > 1) {
			for (const [k, v] of counts) if (v < minDf) counts.delete(k);
		}
		return counts;
	}

	/**
	 * Morphological stem, used to dedup labels that differ only by inflection
	 * ("subscription" / "subscriptions" / "subscribe" collapse to one).
	 */
	stem(term: string): string {
		return stemmer(term);
	}

	private splitIdentifier(id: string): string[] {
		return id
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
			.replace(/[_\-.]/g, " ")
			.toLowerCase()
			.split(/\s+/)
			.filter(Boolean);
	}

	private isAcceptable(p: string): boolean {
		if (p.length < 4 || p.length > 20) return false;
		// Reject anything with digits (v81, schema1, f1c111...)
		if (/\d/.test(p)) return false;
		if (Lexicon.STOPWORDS.has(p)) return false;
		// Pure lowercase letters only
		if (/^[a-z]+$/.test(p) === false) return false;
		// Reject consonant-only strings (tsx, rgb, jwt...)
		if (!/[aeiou]/.test(p)) return false;
		return true;
	}
}
