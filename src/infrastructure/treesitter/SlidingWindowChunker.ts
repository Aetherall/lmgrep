import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Chunk } from "../../domain/corpus/Chunk.js";
import { CodeLocation } from "../../domain/corpus/CodeLocation.js";
import { ContentHash } from "../../domain/corpus/ContentHash.js";
import type { ChunkerPort } from "../../domain/ports/ChunkerPort.js";

/**
 * Fixed-size windows over a file, for sources with no grammar or no chunkable
 * structure (a linear shell script, say).
 *
 * Windows overlap slightly so a passage straddling a boundary is still
 * retrievable. The overlap is kept small because search deduplicates
 * overlapping hits anyway, making a larger one pure index bloat.
 */
export class SlidingWindowChunker implements ChunkerPort {
	private static readonly WINDOW_LINES = 50;
	private static readonly STRIDE_LINES = 40;

	async chunk(filePath: string, cwd: string): Promise<Chunk[]> {
		const source = readFileSync(join(cwd, filePath), "utf-8");
		const lines = source.split("\n");
		if (lines.length === 0) return [];

		const chunks: Chunk[] = [];
		for (
			let i = 0;
			i < lines.length;
			i += SlidingWindowChunker.STRIDE_LINES
		) {
			const content = lines
				.slice(i, i + SlidingWindowChunker.WINDOW_LINES)
				.join("\n");
			if (content.trim().length === 0) continue;

			const endLine = Math.min(
				i + SlidingWindowChunker.WINDOW_LINES,
				lines.length,
			);
			chunks.push(
				new Chunk({
					location: new CodeLocation(filePath, i + 1, endLine),
					type: "block",
					name: `lines_${i + 1}_${endLine}`,
					content,
					context: `[file: ${filePath}]`,
					hash: ContentHash.of(content),
				}),
			);
		}

		return chunks;
	}
}
