import { BisectingKMeans } from "../../domain/faceting/BisectingKMeans.js";
import { ClusterAxes } from "../../domain/faceting/ClusterAxes.js";
import { LabelVocabulary } from "../../domain/faceting/LabelVocabulary.js";
import { Lexicon } from "../../domain/faceting/Lexicon.js";
import type { VectorHit } from "../../domain/ports/ChunkRepositoryPort.js";
import type { VocabRepositoryPort } from "../../domain/ports/VocabRepositoryPort.js";
import type { Hit } from "../../domain/retrieval/Hit.js";

/** One labelled group of results. */
export interface FacetCluster {
	label: string;
	/** Top vocabulary terms for this cluster's contrast axis, label first. */
	candidates: string[];
	/** One term per sibling boundary, deduped — the compact display. */
	qualifiers: string[];
	/** Top terms against each sibling individually — the verbose display. */
	disambiguators: Array<{ vs: string; terms: string[] }>;
	size: number;
	hits: Hit[];
	/** Positions of this cluster's members in the input, for session pooling. */
	memberIndices: number[];
}

/**
 * Turns a page of results into labelled clusters.
 *
 * The value is the labelling, not the clustering: grouping vectors is easy,
 * but naming each group in the codebase's own vocabulary is what tells a user
 * that "auth" splits into `fireauth`, `oauth` and `serviceaccount`. Labels come
 * from asking the vocabulary index which term sits nearest each cluster's
 * contrast axis.
 */
export class FacetEngine {
	/** Terms shown alongside a label to describe its angle. */
	private static readonly CANDIDATES_PER_CLUSTER = 4;
	/** Candidates fetched per axis before stem-deduplication. */
	private static readonly CANDIDATE_POOL = 10;
	/** Candidates fetched per pairwise axis. */
	private static readonly PAIRWISE_POOL = 8;
	/** Terms kept per pairwise boundary in the verbose view. */
	private static readonly TERMS_PER_PAIR = 3;
	/** Qualifiers kept per cluster in the compact view. */
	private static readonly MAX_QUALIFIERS = 4;

	constructor(
		private readonly vocab: VocabRepositoryPort,
		private readonly clusterer = new BisectingKMeans(),
		private readonly lexicon = new Lexicon(),
	) {}

	async cluster(
		hits: VectorHit[],
		query: string,
		k: number,
		ancestorLabels: Set<string> = new Set(),
	): Promise<FacetCluster[]> {
		if (hits.length === 0) return [];

		const vectors = hits.map((h) => h.vector.normalized());
		const clustering = this.clusterer.cluster(
			vectors,
			Math.min(k, hits.length),
		);
		const axes = new ClusterAxes(vectors, clustering);
		const vocabulary = new LabelVocabulary(
			this.lexicon,
			this.lexicon.tokenize(query),
			ancestorLabels,
		);

		const primary = await this.assignLabels(axes, vocabulary);
		const boundaries = await this.describeBoundaries(axes, vocabulary, primary);

		const groups = clustering.groups();
		const clusters: FacetCluster[] = groups.map((members, index) => ({
			label: primary[index].label,
			candidates: primary[index].candidates,
			qualifiers: boundaries[index].qualifiers,
			disambiguators: boundaries[index].rows,
			size: members.length,
			hits: members.map((i) => hits[i].hit),
			memberIndices: [...members],
		}));

		// Biggest first: the largest cluster is the most likely intent.
		clusters.sort((a, b) => b.size - a.size);
		return clusters;
	}

	/**
	 * Name each cluster from its contrast axis, claiming stems as it goes so no
	 * two siblings end up with inflections of one word.
	 */
	private async assignLabels(
		axes: ClusterAxes,
		vocabulary: LabelVocabulary,
	): Promise<Array<{ label: string; stem: string; candidates: string[] }>> {
		const out: Array<{ label: string; stem: string; candidates: string[] }> =
			[];

		for (let cluster = 0; cluster < axes.count; cluster++) {
			const terms = await this.vocab.nearest(
				axes.contrastAxis(cluster),
				FacetEngine.CANDIDATE_POOL,
				vocabulary.excluded,
			);
			const words = terms.map((t) => t.term);
			const { label, stem } = vocabulary.claimLabel(words);

			// The label leads its own candidate list; the rest fill in behind it.
			const candidates =
				label === LabelVocabulary.FALLBACK_LABEL
					? vocabulary.distinctTerms(words, FacetEngine.CANDIDATES_PER_CLUSTER)
					: [
							label,
							...vocabulary.distinctTerms(
								words,
								FacetEngine.CANDIDATES_PER_CLUSTER - 1,
								[stem],
							),
						];

			out.push({ label, stem, candidates });
		}
		return out;
	}

	/**
	 * Describe what separates each cluster from each sibling.
	 *
	 * Pairwise axes are richer than the collapsed contrast axis: they say what
	 * distinguishes this cluster from *that* one specifically, which is what a
	 * user needs when deciding which branch to follow.
	 */
	private async describeBoundaries(
		axes: ClusterAxes,
		vocabulary: LabelVocabulary,
		primary: ReadonlyArray<{ label: string; stem: string }>,
	): Promise<
		Array<{
			qualifiers: string[];
			rows: Array<{ vs: string; terms: string[] }>;
		}>
	> {
		const out: Array<{
			qualifiers: string[];
			rows: Array<{ vs: string; terms: string[] }>;
		}> = [];

		for (let cluster = 0; cluster < axes.count; cluster++) {
			const rows: Array<{ vs: string; terms: string[] }> = [];
			const qualifiers: string[] = [];
			const qualifierStems = new Set<string>([primary[cluster].stem]);

			for (let other = 0; other < axes.count; other++) {
				if (other === cluster) continue;

				const terms = await this.vocab.nearest(
					axes.pairwiseAxis(cluster, other),
					FacetEngine.PAIRWISE_POOL,
					new Set([
						...vocabulary.excluded,
						primary[cluster].label,
						primary[other].label,
					]),
				);
				const words = terms.map((t) => t.term);

				rows.push({
					vs: primary[other].label,
					terms: vocabulary.distinctTerms(words, FacetEngine.TERMS_PER_PAIR, [
						primary[cluster].stem,
						primary[other].stem,
					]),
				});

				// One qualifier per boundary, until the compact view is full.
				if (qualifiers.length >= FacetEngine.MAX_QUALIFIERS) continue;
				const [next] = vocabulary.distinctTerms(words, 1, qualifierStems);
				if (next) {
					qualifiers.push(next);
					qualifierStems.add(vocabulary.stemOf(next));
				}
			}

			out.push({ qualifiers, rows });
		}
		return out;
	}
}
