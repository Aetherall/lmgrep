import type { Hit } from "../../domain/retrieval/Hit.js";

/** Everything a caller can ask of a search. */
export interface SearchOptions {
	limit?: number;
	filePrefix?: string;
	/** Push results away from this meaning. */
	not?: string;
	minScore?: number;
	/** Only chunks of these AST types. */
	type?: string[];
	/** Only files with these extensions (".ts", ".py"). */
	language?: string[];
	/** Search another project's index instead of this one. */
	project?: string;
	/** Search several project indexes and merge by score. */
	across?: string[];
}

/**
 * A search request, with the filters that can only be applied after retrieval.
 *
 * Language and score filters live here rather than in the query because
 * neither is stored in a form the vector index can filter on: extensions are a
 * property of the path, and scores only exist once distances are computed.
 */
export class SearchCriteria {
	static readonly DEFAULT_LIMIT = 25;

	private readonly extensions: Set<string> | undefined;

	constructor(private readonly options: SearchOptions) {
		const languages = options.language;
		this.extensions =
			languages && languages.length > 0
				? new Set(
						languages.map((l) => (l.startsWith(".") ? l : `.${l}`)),
					)
				: undefined;
	}

	get limit(): number {
		return this.options.limit ?? SearchCriteria.DEFAULT_LIMIT;
	}

	get filePrefix(): string | undefined {
		return this.options.filePrefix;
	}

	get types(): string[] | undefined {
		return this.options.type;
	}

	get negation(): string | undefined {
		return this.options.not;
	}

	get project(): string | undefined {
		return this.options.project;
	}

	get across(): string[] | undefined {
		return this.options.across;
	}

	admits(hit: Hit): boolean {
		if (this.extensions && !this.extensions.has(hit.location.extension)) {
			return false;
		}
		if (
			this.options.minScore != null &&
			hit.score < this.options.minScore
		) {
			return false;
		}
		return true;
	}
}
