import { parentPort, workerData } from "node:worker_threads";
import {
	type EmbeddedTreeSitterAssets,
	registerEmbeddedTreeSitterAssets,
} from "./EmbeddedTreeSitterAssets.js";
import { TreeSitterChunker } from "./TreeSitterChunker.js";

/** A chunk flattened to plain data, the only shape a worker can post back. */
export interface ChunkData {
	filePath: string;
	startLine: number;
	endLine: number;
	type: string;
	name: string;
	content: string;
	context: string;
	hash: string;
}

export interface ChunkRequest {
	id: number;
	filePath: string;
	cwd: string;
}

export type ChunkResponse =
	| { id: number; chunks: ChunkData[] }
	| { id: number; error: string };

const assets = (workerData as { assets?: EmbeddedTreeSitterAssets } | null)
	?.assets;
if (assets) registerEmbeddedTreeSitterAssets(assets);

const chunker = new TreeSitterChunker();

parentPort?.on("message", async ({ id, filePath, cwd }: ChunkRequest) => {
	let response: ChunkResponse;
	try {
		const chunks = await chunker.chunk(filePath, cwd);
		response = {
			id,
			chunks: chunks.map((chunk) => ({
				filePath: chunk.location.filePath,
				startLine: chunk.location.startLine,
				endLine: chunk.location.endLine,
				type: chunk.type,
				name: chunk.name,
				content: chunk.content,
				context: chunk.context,
				hash: chunk.hash.toString(),
			})),
		};
	} catch (error) {
		response = {
			id,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	parentPort?.postMessage(response);
});
