# lmgrep

Semantic code search powered by AI embeddings. Index your codebase with any embedding provider and search it using natural language.

lmgrep uses [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) to parse source code into meaningful chunks (functions, classes, interfaces, etc.), embeds them with the AI model of your choice, and stores the vectors in a local [LanceDB](https://lancedb.github.io/lancedb/) database. Queries are matched by semantic similarity, so you find code by *intent* rather than exact strings.

## Features

- **Any embedding provider** — works with Ollama, OpenAI, Google, or any provider supported by the [Vercel AI SDK](https://sdk.vercel.ai/)
- **Tree-sitter chunking** — splits code at AST boundaries so search results are complete, meaningful units
- **MCP server** — built-in MCP server (`lmgrep mcp`) for integration with Claude Code, Cursor, and other AI tools
- **File watching** — `lmgrep serve` watches for changes and incrementally re-indexes
- **P2P sharing** — share your index with teammates via direct peer-to-peer transfer
- **Cross-project search** — search across multiple indexed projects
- **Git-aware** — respects `.gitignore`, deduplicates across worktrees sharing the same remote
- **Configurable** — global or per-project config, custom ignore patterns, extension filtering

## Quick start

### 1. Install

```sh
pnpm install -g lmgrep
```

### 2. Set up an embedding model

The fastest way to get started is with [Ollama](https://ollama.com/):

```sh
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull an embedding model
ollama pull nomic-embed-text

# Auto-detect and write config
lmgrep init
```

This creates a config file at `~/.config/lmgrep/config.yml` (Linux) or `~/Library/Application Support/lmgrep/config.yml` (macOS).

### 3. Index your project

```sh
cd /path/to/your/project
lmgrep index
```

### 4. Search

```sh
lmgrep search "how are users authenticated"
lmgrep search "database connection pooling" --limit 5
lmgrep search "error handling" --file-prefix src/lib --language .ts
```

## CLI commands

| Command | Description |
|---|---|
| `lmgrep index` | Index the current directory |
| `lmgrep search <query>` | Search using natural language |
| `lmgrep status` | Show index stats, embedding connectivity, and running processes |
| `lmgrep serve` | Watch for changes and re-index automatically |
| `lmgrep mcp` | Start the MCP server (stdio transport) |
| `lmgrep init` | Detect embedding setup and create config |
| `lmgrep config` | Open the global config in your editor |
| `lmgrep repair` | Detect and fix index inconsistencies |
| `lmgrep compact` | Compact the index to reclaim disk space |
| `lmgrep export` | Share this project's index with a peer via P2P |
| `lmgrep import [source]` | Import from a peer (share code) or local database |
| `lmgrep prune` | Delete the index for the current directory |
| `lmgrep completions zsh` | Output or install zsh completions |

### Search options

```
--limit <n>          Max results (default: 25)
--file-prefix <path> Only search files under this path
--language <exts>    Filter by file extension (e.g. .ts,.py)
--type <types>       Filter by AST node type (e.g. function_declaration)
--not <query>        Exclude results similar to this query
--scores             Show relevance scores
--compact            Show file paths only
--json               Output as JSON
--project <path>     Search a different project's index
--across <paths>     Search multiple projects (comma-separated)
```

### Index options

```
--reset       Rebuild the entire index from scratch
--since <dur> Only re-index files modified within duration (e.g. 10m, 2h, 1d)
--force       Force re-embed even if file hash is unchanged
--dry         Show what would be indexed without doing it
--verbose     Show file-by-file progress
```

## P2P index sharing

Share your index with a teammate without any server or infrastructure. Uses [Hyperswarm](https://github.com/holepunchto/hyperswarm) for direct encrypted peer-to-peer transfer with NAT hole punching.

```sh
# On your machine — start sharing
lmgrep export
# → Share code: lmgrepoceantiger7f3a
# → Waiting for peer...

# On their machine — receive the index
lmgrep import lmgrepoceantiger7f3a
# → Connecting to peer...
# → Receiving: 4823/4823 chunks
# → Imported 4823 chunks and 312 file hashes from peer.
```

Requires `hyperswarm` to be installed (`pnpm add hyperswarm`). It's an optional dependency — lmgrep works fine without it.

## MCP server

lmgrep includes an MCP server for use with AI coding assistants. When launched with no arguments over piped stdio (as MCP clients do), it automatically starts in MCP mode. Just add it to your tool's MCP configuration:

```json
{
  "mcpServers": {
    "lmgrep": {
      "command": "lmgrep"
    }
  }
}
```

You can also start it explicitly with `lmgrep mcp`.

The MCP server exposes a `search` tool and a `list_other_indexed_projects` tool. It automatically watches for file changes and keeps the index up to date.

## Configuration

lmgrep looks for configuration in this order:

1. `.lmgrep.yml` in the project root (per-project)
2. `~/.config/lmgrep/config.yml` (global, Linux) or `~/Library/Application Support/lmgrep/config.yml` (macOS)
3. `~/.lmgrep.yml` (legacy fallback)

### Example config

```yaml
# Embedding model in "provider:model" format
model: ollama:nomic-embed-text

# Base URL for the embedding API
baseURL: http://localhost:11434/v1

# Batch size for embedding API calls
batchSize: 100

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

# Optional: file extension control
# extensions:
#   include: [".sql", ".graphql", ".proto"]
#   exclude: [".json"]
```

### Using other providers

Install the provider package globally and set the model accordingly:

```sh
# OpenAI
npm install -g @ai-sdk/openai
# then in config: model: openai:text-embedding-3-small

# Google
npm install -g @ai-sdk/google
# then in config: model: google:text-embedding-004
```

## Development

```sh
pnpm install
pnpm build        # compile TypeScript
pnpm dev          # watch mode
pnpm check        # format and lint (Biome)
```

## License

GPL-3.0
