import type { Chunk } from "../corpus/Chunk.js";

/** Splits a source file into indexable chunks. */
export interface ChunkerPort {
	chunk(filePath: string, cwd: string): Promise<Chunk[]>;
}
