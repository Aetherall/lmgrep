# lmgrep

Semantic code search powered by AI embeddings. Index your codebase with any embedding provider and search it using natural language.

lmgrep uses [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) to parse source code into meaningful chunks (functions, classes, interfaces, etc.), embeds them with the AI model of your choice, and stores the vectors in a local [LanceDB](https://lancedb.github.io/lancedb/) database. Queries are matched by semantic similarity, so you find code by *intent* rather than exact strings.

## Features

- **Any embedding provider** — works with Ollama, OpenAI, Google, or any provider supported by the [Vercel AI SDK](https://sdk.vercel.ai/)
- **Tree-sitter chunking** — splits code at AST boundaries so search results are complete, meaningful units
- **Ask (research mode)** — `lmgrep ask` runs a local model that searches, reads, and synthesizes a cited answer, so agents spend one call instead of many searches
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
| `lmgrep ask <question>` | Answer a question with a local research loop (search → read → cited answer) |
| `lmgrep status` | Show index stats, embedding connectivity, and running processes |
| `lmgrep serve` | Watch for changes and re-index automatically |
| `lmgrep mcp` | Start the MCP server (stdio transport) |
| `lmgrep init` | Detect embedding setup and create config |
| `lmgrep config` | Open the global config in your editor |
| `lmgrep repair` | Detect and fix index inconsistencies |
| `lmgrep migrate` | Rename existing index directories to match the current slug scheme |
| `lmgrep compact` | Reclaim disk, drop stale chunks, and build the vector index |
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

## Ask (research mode)

`lmgrep ask` answers a question *about the codebase* instead of returning raw chunks. A local chat model runs a short agentic loop — it searches the index, reads the matching code, and writes a concise answer where every claim is cited as `[n] → file:line`. This is aimed at AI agents: one `ask` call replaces several searches and pages of chunks, so it's far cheaper on the agent's context.

It requires a generative `chatModel` in addition to your embedding `model`. On a local runtime (LM Studio, Ollama) it reuses the same provider and `baseURL`, so one extra config line is enough:

```yaml
# ~/.config/lmgrep/config.yml (or .lmgrep.yml)
model: lmstudio:text-embedding-nomic-embed-code   # embeddings (retrieval)
chatModel: lmstudio:google/gemma-4-e2b            # generation (the research loop)
```

```sh
lmgrep ask "how does the file watcher trigger reindexing"
lmgrep ask "where are webhooks authenticated and what token format" --json
```

The answer, its `Sources:` list, and a one-line trace (queries run, steps, time) are printed; the live search trace streams to stderr (silence it with `--quiet`). When configured, `ask` is also exposed as an MCP tool alongside `search`.

```
--json      Output the full result (answer, sources, trace) as JSON
--quiet     Suppress the live research trace on stderr
--database  Target a specific database by name or path
```

Config keys: `chatModel` (required for `ask`), `chatProvider` / `chatBaseURL` (default to the embedding `provider` / `baseURL`), `chatMaxSteps` (default 8), `chatTimeoutMs` (per model call, default 240000).

## Targeting a database

By default every command picks its database from the current directory, git-aware: one database per repo, scoped to the checked-out branch. `--database` overrides that and works on `index`, `search`, `ask`, `status`, `repair`, `serve`, `mcp`, `compact`, and `prune`.

```sh
# A bare name — an independent index under ~/.local/state/lmgrep/<name>
lmgrep index --database notes
lmgrep search "retry policy" --database notes

# A path (anything containing a separator) — a specific database directory
lmgrep search "retry policy" --database ./tmp/scratch-index
```

The files indexed still come from the current directory; only the database identity changes. A manually targeted database is flat: it is branch-agnostic, so switching git branches never hides results, and it does not participate in the ancestor-prefix resolution that lets you search a parent repo's index from a subdirectory.

`prune` refuses to delete a `--database` path that isn't recognizably an lmgrep database.

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

### Claude Code

```sh
# If lmgrep is installed globally
claude mcp add lmgrep -s user -- lmgrep mcp

# Or without a global install
claude mcp add lmgrep -s user -- npx -y lmgrep mcp
```

### Codex CLI

```sh
# If lmgrep is installed globally
codex mcp add lmgrep -- lmgrep mcp

# Or without a global install
codex mcp add lmgrep -- npx -y lmgrep mcp
```

### Gemini CLI

```sh
# If lmgrep is installed globally
gemini mcp add lmgrep -- lmgrep mcp

# Or without a global install
gemini mcp add lmgrep -- npx -y lmgrep mcp
```

### Pi coding agent

Pi doesn't speak MCP — it uses TypeScript extensions instead. lmgrep ships one at [`pi-extension/`](./pi-extension) that registers two tools: `lmgrep_search` and `lmgrep_list_other_indexed_projects`. It imports lmgrep directly, runs an in-process file watcher to keep the index fresh, and gates tool visibility on embedder health — if lmgrep isn't configured, or the embedding provider is unreachable, the tools stay hidden so you get a clean tool surface instead of a broken one. Configure lmgrep first (`lmgrep init`) before relying on it inside Pi.

Install via Pi's package manager:

```sh
pi install git:github.com/Aetherall/lmgrep
```

Update with `pi update`, remove with `pi remove git:github.com/Aetherall/lmgrep`, and list installed extensions with `pi list`.

### OpenCode

OpenCode has no one-shot install flag — add an entry to `~/.config/opencode/opencode.json` (or project-level `opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "lmgrep": {
      "type": "local",
      // If lmgrep is installed globally
      "command": ["lmgrep", "mcp"],
      // Or without a global install
      // "command": ["npx", "-y", "lmgrep", "mcp"],
      "enabled": true
    }
  }
}
```

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

### Architecture

The source is layered, with dependencies pointing inward only:

```
src/
  domain/          entities, value objects, and the port interfaces
  application/     use cases that orchestrate the domain
  infrastructure/  adapters: LanceDB, filesystem, git, AI SDK, tree-sitter, p2p
  presentation/    the CLI and the MCP server
```

`domain/` knows nothing outside itself. `application/` depends on domain ports,
never on a concrete adapter. `LmgrepFactory` is the single place that wires the
graph together, so no entry point needs to know the assembly order.

### Conventions

- **No free functions.** Behaviour lives on the type that owns it. Constant
  tables and pure helpers land as static-only classes, which is why Biome's
  `noStaticOnlyClass` rule is disabled — the shape is intended here.
- **Comments explain why, not what.** A measured constant records what the
  measurement was; a non-obvious ordering records what breaks if it changes.

## License

GPL-3.0
