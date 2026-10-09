export interface EmbeddedTreeSitterAssets {
	parser: string;
	grammars: Readonly<Record<string, string>>;
	/**
	 * Where the bundle placed the chunk worker entry point. A bundle inlines
	 * modules, so the worker's path relative to its importer no longer holds.
	 */
	chunkWorker?: string;
}

let embedded: EmbeddedTreeSitterAssets | undefined;

/** Registers paths embedded by the standalone Bun entry point. */
export function registerEmbeddedTreeSitterAssets(
	assets: EmbeddedTreeSitterAssets,
): void {
	embedded = assets;
}

export function embeddedParserPath(): string | undefined {
	return embedded?.parser;
}

export function embeddedGrammarPath(wasmFile: string): string | undefined {
	return embedded?.grammars[wasmFile];
}

export function embeddedChunkWorker(): string | undefined {
	return embedded?.chunkWorker;
}

/** The registered assets, for handing to worker threads that start empty. */
export function embeddedAssets(): EmbeddedTreeSitterAssets | undefined {
	return embedded;
}
