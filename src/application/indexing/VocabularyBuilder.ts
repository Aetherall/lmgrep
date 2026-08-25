import { Lexicon } from "../../domain/faceting/Lexicon.js";
import type { ChunkText } from "../../domain/ports/ChunkRepositoryPort.js";
import type { EmbedderPort } from "../../domain/ports/EmbedderPort.js";
import type { LoggerPort } from "../../domain/ports/LoggerPort.js";
import type { VocabRepositoryPort } from "../../domain/ports/VocabRepositoryPort.js";

export interface VocabularyBuildOptions {
	/** Minimum number of chunks a term must appear in to be kept. */
	minDf?: number;
	embedBatchSize?: number;
}

/**
 * Builds the vocabulary index that gives facet clusters their labels.
 *
 * Terms are filtered by document frequency: a word appearing in only a couple
 * of chunks describes those chunks, not a category, and would make a useless
 * label. The threshold is what separates the codebase's real vocabulary from
 * incidental identifiers.
 */
export class VocabularyBuilder {
	private static readonly DEFAULT_MIN_DF = 10;
	private static readonly DEFAULT_EMBED_BATCH = 200;

	constructor(
		private readonly vocab: VocabRepositoryPort,
		private readonly embedder: EmbedderPort,
		private readonly logger: LoggerPort,
		private readonly lexicon = new Lexicon(),
	) {}

	async build(
		chunks: Iterable<ChunkText>,
		options: VocabularyBuildOptions = {},
	): Promise<{ added: number }> {
		const minDf = options.minDf ?? VocabularyBuilder.DEFAULT_MIN_DF;
		const batchSize =
			options.embedBatchSize ?? VocabularyBuilder.DEFAULT_EMBED_BATCH;

		const frequencies = this.lexicon.collectVocabulary(this.textsOf(chunks), {
			minDf,
		});
		if (frequencies.size === 0) return { added: 0 };

		const known = await this.vocab.storedTerms();
		const toEmbed = [...frequencies.keys()].filter((t) => !known.has(t));
		if (toEmbed.length === 0) return { added: 0 };

		this.logger.info(`Embedding ${toEmbed.length} new vocab terms...`);

		let added = 0;
		for (let i = 0; i < toEmbed.length; i += batchSize) {
			const batch = toEmbed.slice(i, i + batchSize);
			const vectors = await this.embedder.embedDocuments(batch);
			await this.vocab.add(
				batch.map((term, j) => ({ term, vector: vectors[j] })),
			);
			added += batch.length;
			this.logger.info(`Vocab: ${added}/${toEmbed.length}`);
		}

		return { added };
	}

	private *textsOf(chunks: Iterable<ChunkText>): Iterable<string> {
		for (const c of chunks) yield `${c.name} ${c.content}`;
	}
}
