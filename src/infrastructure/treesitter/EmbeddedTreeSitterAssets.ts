export interface EmbeddedTreeSitterAssets {
	parser: string;
	grammars: Readonly<Record<string, string>>;
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
