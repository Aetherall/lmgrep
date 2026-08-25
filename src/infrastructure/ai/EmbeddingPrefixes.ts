/**
 * Query and document prefixes required by asymmetric embedding models.
 *
 * These models are trained with the prefixes present, and omitting them
 * degrades retrieval without producing any error — the vectors are still
 * valid, just worse. Nobody discovers that from the tool; they discover it
 * from the model card, if at all. Setting them at `init` time is the only
 * point where the model is actually known.
 *
 * Deliberately short: it covers only families whose prefixes are documented
 * and unambiguous. An unrecognized model gets none, which is the safe default.
 */
export class EmbeddingPrefixes {
	private static readonly KNOWN: ReadonlyArray<{
		match: RegExp;
		query: string;
		document: string;
		family: string;
	}> = [
		{
			match: /nomic-embed/i,
			query: "search_query: ",
			document: "search_document: ",
			family: "nomic-embed",
		},
		{
			match: /(^|[^a-z])e5[-_]|multilingual-e5/i,
			query: "query: ",
			document: "passage: ",
			family: "e5",
		},
	];

	/** Prefixes for a model id, or undefined when none are known to apply. */
	static forModel(
		modelId: string,
	): { query: string; document: string; family: string } | undefined {
		const found = EmbeddingPrefixes.KNOWN.find((e) => e.match.test(modelId));
		if (!found) return undefined;
		return {
			query: found.query,
			document: found.document,
			family: found.family,
		};
	}
}
