/** Everything `init` managed to work out about the local setup. */
export interface DetectedSettings {
	model?: string;
	baseURL?: string;
	providerPackage?: string;
	local?: boolean;
	chatModel?: string;
	prefixes?: { query: string; document: string; family: string };
}

/**
 * The starter `config.yml` written by `lmgrep init`.
 *
 * Every optional setting is present but commented out. That is deliberate: it
 * doubles as the reference documentation a user actually reads, so an option
 * they never knew existed is one line away rather than in a README.
 */
export class ConfigTemplate {
	static render(detected?: DetectedSettings): string {
		const modelLine = detected?.model
			? `model: ${detected.model}`
			: "# model: ollama:nomic-embed-text  # ← set your model here";
		const baseURLLine = detected?.baseURL
			? `baseURL: ${detected.baseURL}`
			: "# baseURL: http://localhost:11434/v1";
		const providerLine = detected?.providerPackage
			? `provider: "${detected.providerPackage}"`
			: '# provider: "@ai-sdk/openai-compatible"';
		const localLine = detected?.local ? "local: true" : "# local: true";

		// Asymmetric models need these and fail silently without them, so they
		// are written out rather than left commented.
		const prefixLines = detected?.prefixes
			? [
					`# ${detected.prefixes.family} models are asymmetric — these prefixes are required.`,
					`queryPrefix: "${detected.prefixes.query}"`,
					`documentPrefix: "${detected.prefixes.document}"`,
				].join("\n")
			: [
					'# queryPrefix: "search_query: "',
					'# documentPrefix: "search_document: "',
				].join("\n");

		const chatLine = detected?.chatModel
			? `chatModel: ${detected.chatModel}`
			: "# chatModel: lmstudio:qwen/qwen3.5-9b";

		return `# lmgrep configuration
#
# Quick start with Ollama:
#   1. Install: curl -fsSL https://ollama.com/install.sh | sh
#   2. Pull a model: ollama pull nomic-embed-text
#   3. Run: lmgrep init --force  (to auto-detect)

# Embedding model in "provider:model" format
${modelLine}

# Base URL for the embedding API
${baseURLLine}

# AI SDK package providing the model
${providerLine}

# Provider runs locally, so health checks may probe it freely
${localLine}

# Batch size for embedding API calls
batchSize: 100

${prefixLines}

# Generative model for \`lmgrep ask\`. Optional — without it, \`ask\` is hidden.
${chatLine}

# Optional: embedding dimensions (if model supports it)
# dimensions: 384

# Optional: max tokens per chunk (estimated at 4 chars/token)
# maxTokens: 8192

# Optional: additional ignore patterns (merged with .gitignore)
# ignore:
#   - "*.generated.ts"
#   - "fixtures/"

# Optional: extra file extensions to index
# extensions:
#   include: [".sql", ".graphql", ".proto"]
#   exclude: [".json"]
`;
	}
}
