# lmgrep

Semantic code search powered by AI embeddings. Index your codebase with any embedding provider and search it using natural language.

lmgrep uses [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) to parse source code into meaningful chunks (functions, classes, interfaces, etc.), embeds them with the AI model of your choice, and stores the vectors in a local [LanceDB](https://lancedb.github.io/lancedb/) database. Queries are matched by semantic similarity, so you find code by *intent* rather than exact strings.

## Features

- **Any embedding provider** — works with Ollama, OpenAI, Google, or any provider supported by the [Vercel AI SDK](https://sdk.vercel.ai/)
- **Tree-sitter chunking** — splits code at AST boundaries so search results are complete, meaningful units
- **The index lives in the repo** — under `.git/lmgrep/`, so `du` finds it, `rm -rf` removes it, and deleting a clone deletes its index
- **One index per model** — switching embedding models selects a different database instead of invalidating the one you have; switching back is instant
- **Ask (research mode)** — `lmgrep ask` runs a local model that searches, reads, and synthesizes a cited answer, so agents spend one call instead of many searches
- **MCP server** — built-in MCP server (`lmgrep mcp`) for integration with Claude Code, Cursor, and other AI tools
- **File watching** — `lmgrep serve` watches for changes and incrementally re-indexes
- **P2P sharing** — share your index with teammates via direct peer-to-peer transfer
- **Cross-project search** — search across multiple indexed projects
- **Git-aware** — respects `.gitignore`, and every worktree of a repository shares one index

## Quick start

### 1. Install

```sh
pnpm install -g lmgrep
```

Requires Node.js 20 or newer.

#### Standalone executable

Release builds can bundle lmgrep, the Bun runtime, the OpenAI-compatible model
adapter, LanceDB native binding, and every Tree-sitter grammar into one file:

```sh
pnpm install
pnpm build:standalone
./artifacts/lmgrep --help
```

The executable targets the operating system and architecture running Bun, so
build each release artifact on its target platform. For the auto-detected
local runtimes, users need neither Node.js, Bun, npm packages, nor a separately
installed provider adapter.

### 2. Set up an embedding model

Start a local inference server, then let lmgrep configure itself.

With [Ollama](https://ollama.com/):

```sh
curl -fsSL https://ollama.com/install.sh | sh
ollama pull nomic-embed-text
lmgrep init
```

Or with [Docker Model Runner](https://docs.docker.com/ai/model-runner/):

```sh
docker model pull ai/mxbai-embed-large
lmgrep init
```

LM Studio is supported too: install an embedding model, enable its local
server, and run `lmgrep init`.

`init` detects whichever server is running, picks an embedding model, and
writes the provider, base URL and any prefixes that model requires. Where the
server also reports a chat model it configures `chatModel` too, which is what
enables `lmgrep ask`.

Use `lmgrep init --preview` to inspect the detected YAML without creating or
overwriting the config file.

This creates a config file at `~/.config/lmgrep/config.yml` (Linux) or `~/Library/Application Support/lmgrep/config.yml` (macOS).

### 3. Index your project

```sh
cd /path/to/your/project
lmgrep index
```

### 4. Search

A bare query searches — `search` is the default command:

```sh
lmgrep how are users authenticated
lmgrep search "database connection pooling" --limit 5
lmgrep search "error handling" --under src/lib --language .ts
```

## CLI commands

Two of these are the product; the rest you run once.

| Command | Description |
|---|---|
| `lmgrep <query>` | Search using natural language (`search` is the default command) |
| `lmgrep ask <question>` | Answer a question with a local research loop (search → read → cited answer) |
| `lmgrep index` | Index this project, and keep it current |
| `lmgrep status` | Report whether search works, and why not |
| `lmgrep projects` | List every index on this machine, and reclaim their space |
| `lmgrep init` | Detect your local models and write the machine config |
| `lmgrep config` | Open the machine config in your editor |
| `lmgrep mcp` | Start the MCP server (stdio transport) |
| `lmgrep serve` | Watch this project and re-index as files change |
| `lmgrep share` | Offer this project's index to a peer over P2P |
| `lmgrep import <source>` | Import from a peer (share code) or another database (path) |
| `lmgrep completions zsh` | Output or install zsh completions |

There is no `repair`, `compact`, or `migrate`. Reconciling the manifest,
dropping duplicate rows, compacting fragments and training the vector index all
happen inside `lmgrep index`, which is the one moment you are already waiting.
`prune` became `lmgrep projects rm`, which can see what it is deleting.

### Search options

```
--limit <n>       Max results (default: 25)
--under <path>    Only search files under this path
--language <exts> Only search these extensions (e.g. .ts,.py)
--compact         Print matching file paths only
--json            Print results as JSON
--in <target>     Repeatable: a project directory, or a standalone index name
```

### Index options

```
--reset       Discard the index and rebuild from scratch
--since <dur> Only consider files modified within duration (e.g. 10m, 2h, 1d)
--dry         Report what would be indexed, and stop
--verbose     Show file-by-file progress
--in <target> A project directory, or a standalone index name
```

## Ask (research mode)

`lmgrep ask` answers a question *about the codebase* instead of returning raw chunks. A local chat model runs a short agentic loop — it searches the index, reads the matching code, and writes a concise answer where every claim is cited as `[n] → file:line`. This is aimed at AI agents: one `ask` call replaces several searches and pages of chunks, so it's far cheaper on the agent's context.

It requires a generative `chatModel` in addition to your embedding `model`. On a local runtime (LM Studio, Ollama) it reuses the same provider and `baseURL`, so one extra config line is enough:

```yaml
# ~/.config/lmgrep/config.yml
model: lmstudio:text-embedding-nomic-embed-code   # embeddings (retrieval)
chatModel: lmstudio:google/gemma-4-e2b            # generation (the research loop)
```

```sh
lmgrep ask "how does the file watcher trigger reindexing"
lmgrep ask "where are webhooks authenticated and what token format" --json
```

The answer, its `Sources:` list, and a one-line trace (queries run, steps, time) are printed; the live search trace streams to stderr (silence it with `--quiet`). When configured, `ask` is also exposed as an MCP tool alongside `search`.

```
--json   Print the full result (answer, sources, trace) as JSON
--quiet  Suppress the live research trace on stderr
--in     A project directory, or a standalone index name
```

Config keys: `chatModel` (required for `ask`), `chatProvider` / `chatBaseURL` (default to the embedding `provider` / `baseURL`), `chatMaxSteps` (default 8), `chatTimeoutMs` (per model call, default 240000).

## The vector index

Above a few thousand chunks lmgrep trains an ANN index over the embeddings.
Without one, every search brute-force scans the whole table: roughly the
index's own size in peak memory per query, and an order of magnitude more
latency. `lmgrep status` reports which mode you are in.

It is built automatically by `lmgrep index`, and by `lmgrep serve` / the MCP
server on their first catch-up pass. Training briefly needs several GB, so it
happens once rather than on every incremental update — and never behind a
background watcher that has not caught up yet. If `status` reports it missing,
`lmgrep index` builds it.

## Where the index lives

Inside the repository it indexes:

```
<repo>/.git/lmgrep/<model>/
```

Git resolves `.git` to the main checkout even from a linked worktree, so every
worktree of a repository shares one index automatically — no registry, nothing
to keep in sync. Git never walks its own directory, so the index is never
committed and never indexed. And because it is *there*, `du -sh` finds it,
`rm -rf` removes it, and deleting a clone deletes its index with it.

Each embedding model gets its own subdirectory. Changing `model` in your config
selects a different database rather than invalidating the one you have, so
trying another model costs one re-index and switching back costs nothing.

### Changing your embedding model

The new model has no index yet, so lmgrep says so and names what you already
have:

```
$ lmgrep how are webhooks authenticated
This project has no index for "qwen3-embedding-4b" — but it is indexed with
"nomic-embed-code".
Set `model` back to lmstudio:nomic-embed-code to use that index immediately, or
run `lmgrep index` to embed this project with the new model (the other index is
kept).
```

`status` gives the same answer, and `lmgrep index` says what it is about to do
before it starts — embedding a large repository takes a while, and trying a
model out should not commit you to it by accident. Both indexes then coexist,
and `model` decides which one answers.

Note that `serve` and the MCP server read configuration once, at startup. A
server already running keeps using the model it started with — self-consistent,
but it will disagree with the CLI until you restart it. `lmgrep status
--verbose` prints the database each running process is holding.

Projects outside a git repository, and indexes you name yourself, live under
`~/.local/state/lmgrep/db/`. Lock files and a small pointer registry live
beside it — that registry is what `lmgrep projects` and cross-project search
read, since an index inside a repository cannot be found by listing a
directory.

### Targeting another index

`--in` takes a project directory or the name of a standalone index, and repeats:

```sh
# A standalone index, for a corpus that is not a repository
lmgrep index --in notes
lmgrep search "retry policy" --in notes

# Another project
lmgrep search "retry policy" --in ../other-repo

# Several at once; `.` includes the current project
lmgrep search "retry policy" --in . --in ../other-repo
```

For write commands the files indexed still come from the current directory;
only the database identity changes. A standalone index is flat — branch-agnostic,
so switching git branches never hides results.

### Seeing and reclaiming

```sh
lmgrep projects            # every index, largest first, with its model and size
lmgrep projects adopt      # move a pre-0.2 index into this repository, no re-embed
lmgrep projects rm         # delete this project's index
lmgrep projects gc         # delete indexes whose project no longer exists
```

`rm` and `gc` refuse to recurse into anything that is not recognizably an
lmgrep database.

## P2P index sharing

Share your index with a teammate without any server or infrastructure. Uses [Hyperswarm](https://github.com/holepunchto/hyperswarm) for direct encrypted peer-to-peer transfer with NAT hole punching.

```sh
# On your machine — start sharing
lmgrep share
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

There are two kinds of setting, split by what they describe.

**Machine settings** — which model to embed with, which to answer with, where
those servers listen — describe this computer. They live in one file:

- `~/.config/lmgrep/config.yml` (Linux) or `~/Library/Application Support/lmgrep/config.yml` (macOS)
- `~/.lmgrep.yml` still works, as a deprecated location

**Project settings** — what to ignore, which extensions to index — describe a
repository, are worth committing, and go in a `.lmgrep.yml` inside it.

A machine setting written in a project file is reported and ignored. The model
decides what a stored vector *means*, so a project file able to change it was
the single most confusing thing about lmgrep: two files could set `model`, and
`status` would print the winner without saying which file it came from. If you
want a different model for one corpus, index it under `--in <name>` — the model
is a property of an index, not of a directory.

`lmgrep status` prints exactly which file supplied which keys.

### Machine config

```yaml
# Embedding model in "provider:model" format
model: ollama:nomic-embed-text

# Base URL for the embedding API
baseURL: http://localhost:11434/v1

# Batch size for embedding API calls
batchSize: 100

# Generative model for `lmgrep ask`. Optional — without it, `ask` is hidden.
# chatModel: lmstudio:qwen/qwen3.5-9b

# Optional: embedding dimensions (if the model supports it)
# dimensions: 384

# Optional: max tokens per chunk (estimated at 4 chars/token)
# maxTokens: 8192

# Optional: prefixes for asymmetric embedding models
# queryPrefix: "search_query: "
# documentPrefix: "search_document: "
```

### Project config — `.lmgrep.yml`

```yaml
# Additional ignore patterns (merged with .gitignore)
ignore:
  - "*.generated.ts"
  - "fixtures/"

# File extension control
extensions:
  include: [".sql", ".graphql", ".proto"]
  exclude: [".json"]
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
