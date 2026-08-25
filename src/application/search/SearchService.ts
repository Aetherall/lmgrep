import type { LmgrepConfig } from "../../domain/config/LmgrepConfig.js";
import type { Vector } from "../../domain/faceting/Vector.js";
import type { EmbedderPort } from "../../domain/ports/EmbedderPort.js";
import type { LoggerPort } from "../../domain/ports/LoggerPort.js";
import { ModelIdentity } from "../../domain/project/ModelIdentity.js";
import { HitList } from "../../domain/retrieval/HitList.js";
import type { ProjectMetadata } from "../../infrastructure/fs/ProjectMetadataStore.js";
import type { SearchCriteria } from "./SearchCriteria.js";
import type {
	SearchTarget,
	SearchTargetResolver,
} from "./SearchTargetResolver.js";

/**
 * Runs a semantic search: embed the query, retrieve from every target index,
 * merge, and apply the filters retrieval cannot.
 */
export class SearchService {
	/**
	 * How strongly a `--not` query pushes results away. Full subtraction
	 * overshoots into unrelated space; half keeps the original intent dominant
	 * while still displacing the unwanted sense.
	 */
	private static readonly NEGATION_WEIGHT = 0.5;

	constructor(
		private readonly embedder: EmbedderPort,
		private readonly targets: SearchTargetResolver,
		private readonly config: LmgrepConfig,
		private readonly logger: LoggerPort,
		private readonly readMetadata: () => ProjectMetadata | undefined,
	) {}

	async search(query: string, criteria: SearchCriteria): Promise<HitList> {
		const queryVector = await this.buildQueryVector(query, criteria);

		const targets = await this.targets.resolve(criteria);
		try {
			const merged = await this.retrieveFrom(targets, queryVector, criteria);
			return merged.filtered((hit) => criteria.admits(hit));
		} finally {
			await this.targets.release(targets);
		}
	}

	private async retrieveFrom(
		targets: SearchTarget[],
		queryVector: Vector,
		criteria: SearchCriteria,
	): Promise<HitList> {
		let merged = HitList.empty();

		for (const target of targets) {
			const page = await target.chunks.search({
				vector: queryVector,
				limit: criteria.limit,
				filePrefix: target.filePrefix,
				types: criteria.types,
				// A foreign index has no manifest for our branch, so scoping to
				// it would filter everything away.
				scopeToBranch: target.projectRoot === undefined,
			});

			merged = merged.concat(
				target.projectRoot
					? page.mapped((hit) =>
							hit.relocatedUnder(target.projectRoot as string),
						)
					: page,
			);
		}

		// Scores are comparable across indexes only when the same model built
		// them; re-sorting is still the best available merge.
		return targets.length > 1
			? merged.sortedByScoreDescending().takeAtMost(criteria.limit)
			: merged;
	}

	private async buildQueryVector(
		query: string,
		criteria: SearchCriteria,
	): Promise<Vector> {
		const vector = await this.embedder.embedQuery(query);
		this.verifyModelCompatibility(vector);

		const negation = criteria.negation;
		if (!negation) return vector;

		const away = await this.embedder.embedQuery(negation);
		return vector.minus(away.scaledBy(SearchService.NEGATION_WEIGHT));
	}

	/**
	 * A width mismatch is fatal — the vectors are simply incomparable. A family
	 * mismatch is only a warning: results degrade rather than break, and the
	 * user may have deliberately swapped a compatible model.
	 */
	private verifyModelCompatibility(queryVector: Vector): void {
		const meta = this.readMetadata();
		if (!meta) return;

		if (meta.dimensions != null && queryVector.dimensions !== meta.dimensions) {
			throw new Error(
				`Dimension mismatch: index has ${meta.dimensions}-dim vectors but ` +
					`your model produces ${queryVector.dimensions}-dim. ` +
					"These embeddings are incompatible.",
			);
		}

		if (!meta.model) return;
		const indexModel = ModelIdentity.of(meta.model);
		const queryModel = ModelIdentity.of(this.config.model);
		if (!indexModel.isSameFamilyAs(queryModel)) {
			this.logger.info(
				`Warning: index was built with "${meta.model}" (${indexModel.family}) ` +
					`but searching with "${this.config.model}" (${queryModel.family}). ` +
					"Results may be degraded if these are different model families.",
			);
		}
	}
}
