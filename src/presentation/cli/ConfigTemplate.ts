/**
 * The starter `config.yml` written by `lmgrep init`.
 *
 * Every optional setting is present but commented out. That is deliberate: it
 * doubles as the reference documentation a user actually reads, so an option
 * they never knew existed is one line away rather than in a README.
 */
export class ConfigTemplate {
	static render(overrides?: { model?: string; baseURL?: string }): string {
		const modelLine = overrides?.model
			? `model: ${overrides.model}`
			: "# model: ollama:nomic-embed-text  # ← set your model here";
		const baseURLLine = overrides?.baseURL
			? `baseURL: ${overrides.baseURL}`
			: "# baseURL: http://localhost:11434/v1";

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

# Batch size for embedding API calls
batchSize: 100

# Optional: override the provider package
# provider: "@ai-sdk/openai"

# Optional: embedding dimensions (if model supports it)
# dimensions: 384

# Optional: max tokens per chunk (estimated at 4 chars/token)
# maxTokens: 8192

# Optional: prefixes for asymmetric embedding models
# queryPrefix: "search_query: "
# documentPrefix: "search_document: "

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
