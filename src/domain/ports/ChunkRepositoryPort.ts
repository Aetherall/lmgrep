import type { Chunk } from "../corpus/Chunk.js";
import type { ContentHash } from "../corpus/ContentHash.js";
import type { Vector } from "../faceting/Vector.js";
import type { Hit } from "../retrieval/Hit.js";
import type { HitList } from "../retrieval/HitList.js";

/** A chunk paired with the embedding to store alongside it. */
export interface EmbeddedChunk {
	chunk: Chunk;
	vector: Vector;
}

/** A hit that carries its embedding, for client-side clustering. */
export interface VectorHit {
	hit: Hit;
	vector: Vector;
}

/** The filters pushed down into the vector query rather than applied after. */
export interface ChunkQuery {
	vector: Vector;
	limit: number;
	/** Restrict to files under this repo-relative prefix. */
	filePrefix?: string;
	/** Restrict to these AST node types. */
	types?: string[];
	/**
	 * Whether to restrict results to the file versions the current branch
	 * references. Off for cross-project search, where the foreign database has
	 * no manifest for our branch.
	 */
	scopeToBranch: boolean;
}

/** Text of one chunk, for vocabulary building. */
export interface ChunkText {
	name: string;
	content: string;
}

/** Persistence for embedded chunks. */
export interface ChunkRepositoryPort {
	add(chunks: EmbeddedChunk[]): Promise<void>;
	search(query: ChunkQuery): Promise<HitList>;
	/** Same as {@link search} but keeps embeddings, for faceting. */
	searchWithVectors(query: ChunkQuery): Promise<VectorHit[]>;
	findByIds(ids: string[]): Promise<VectorHit[]>;
	deleteByFiles(filePaths: string[]): Promise<void>;
	/** Of the given chunk hashes, those already stored. */
	existingHashes(hashes: ContentHash[]): Promise<Set<string>>;
	count(): Promise<number>;
	/** Chunk hashes grouped by file path, for status reporting. */
	hashesByFile(): Promise<Map<string, string[]>>;
	allHashes(): Promise<Set<string>>;
	streamTexts(batchSize?: number): AsyncGenerator<ChunkText[]>;
}
