# Faceting

## Goal

Add a `lmgrep facet` command that takes a semantic query like `search`, but instead of returning raw result chunks, returns a small list of **dense, one-word facet labels** that best discriminate between the results.

The user can then drill into any facet, view its results, and recursively refine it — building a navigable tree of the search result space at query time.

## UX

```sh
lmgrep facet search "user login"
# kx3   test | form | database | oauth | token | middleware

lmgrep facet list kx3
# test | form | database | oauth | token | middleware

lmgrep facet show kx3/token
# <result chunks in the `token` bucket, search-style output>

lmgrep facet refine kx3/token
# access | refresh | transport | claims

lmgrep facet show kx3/token/access
# <refined result chunks>
```

### Command grammar

| Command | Effect |
|---|---|
| `lmgrep facet search <query>` | Run semantic search; compute root facets; print session id + facet list |
| `lmgrep facet list <path>` | Print the facet list at a node (if computed) |
| `lmgrep facet show <path>` | Print the result chunks at a node |
| `lmgrep facet refine <path>` | Compute child facets for the pool of results at that node |

### Path grammar

- Session id: short opaque token (e.g. `kx3`, 3–4 chars). Identifies a faceting session.
- Path: `<sessionId>/<label>/<label>/...` — each segment is one of the facet labels produced at the previous level.
- Labels are single lowercase words (no spaces, no punctuation) so they are shell/URL safe and compose naturally into paths.

## Why it matters

Raw semantic search returns a ranked list. When the top-N is large or heterogeneous, the user has no structural view of *what kinds of things* came back. Faceting surfaces that structure automatically, per query, with labels meaningful *for that query*.

Unlike precomputed corpus-wide topic models, query-time faceting reflects the query context:
- `"error handling"` → facets split by subsystem (`storage` | `network` | `parser` | `cli`)
- `"database"` → facets split by operation (`read` | `write` | `migration` | `schema`)

Same corpus, different axes, chosen by the query.

## Core design tensions

### 1. Query-time cost vs. quality

A good facet list needs clustering + labeling. Both cost latency. We want facet computation to feel like an interactive search (<1–2s), not a batch job. Small local LLMs (Ollama, 3–7B) can label in a few hundred ms; HDBSCAN on a few hundred vectors is cheap. Budget must stay tight.

### 2. Deterministic assignment vs. LLM naming

LLMs are excellent at *naming* buckets but unreliable at *assigning* items to buckets consistently. Design rule: LLM never does assignment. Assignment is deterministic (clustering on embeddings + metadata); LLM only produces the human-readable label per cluster.

### 3. Single-word labels vs. descriptive phrases

The UX treats labels as path segments. Enforcing single-word lowercase labels:
- Keeps paths clean (`kx3/token/access`)
- Forces the labeler to *summarize* rather than *describe*
- Avoids slug/escaping complexity

Trade-off: some concepts resist single-word compression. Acceptable — better to pick the nearest single word than to bloat the UX.

### 4. Discrimination vs. coverage

A facet axis is useful when it splits the pool into *meaningfully different* and *balanced-enough* buckets. Avoid:
- One bucket dominating (>80%) — not discriminative
- Micro-buckets (<2 items) — noise
- Redundant axes (one facet correlates with another)

## Open questions (to settle via experiments)

### Clustering
- HDBSCAN, k-means, agglomerative, or something else?
- Run on native embedding dims or UMAP-reduced?
- How to pick `min_cluster_size` / `k` from pool size?
- Should we cluster on the full embedding, or on `embedding + metadata features`?

### Labeling
- Batch-naming (one LLM call names all clusters jointly) vs. per-cluster calls?
- How many representative members to feed the labeler per cluster (1, 3, 5)?
- Use chunk `content`, `context`, `name`, or a combination?
- c-TF-IDF fallback quality when LLM unavailable — good enough to ship?
- How to prevent label collisions across siblings? Across ancestors (e.g. refining `token` must not produce `token` again)?

### Pool selection
- How many top-N results to facet over? 100? 500?
- Does N depend on result score distribution (stop at a score cliff)?
- Should refinement re-rank within the bucket, or keep parent order?

### Facet list size
- Fixed k (always 5–7 facets) or adaptive?
- How to handle cohesive result sets where no meaningful split exists?

### Session lifecycle
- TTL? LRU cache size?
- Should `facet search` reuse a recent session for the same query, or always create fresh?

### Quality metrics
We need a way to measure "is this facet list good" offline. Candidates:
- Bucket entropy (balance)
- Silhouette score of clusters
- Label distinctiveness (pairwise embedding distance between label words)
- Human A/B judgment on a small eval set of queries

## Non-goals (for now)

- Multi-axis faceting (Algolia-style: pick multiple facets at once). Start single-axis per level.
- Persistent facet tags in the index. Faceting is ephemeral, per-query.
- Metadata-only facets (type, language, path). Those are cheap to add later but are not the interesting part.
- Cross-project faceting.

## Experiment plan

Experiments should answer the open questions above with concrete measurements on a fixed set of real queries against this repo's own index.

### E1: Clustering method
Compare HDBSCAN, k-means (k=5), agglomerative on the same pool. Measure: silhouette, bucket balance, subjective coherence on 5 queries.

### E2: Dimensionality reduction
Native 384-d vs. UMAP-to-5-d vs. UMAP-to-20-d before clustering. Same queries. Measure: cluster stability, time, coherence.

### E3: Labeler input
Feed the LLM:
- (a) top-1 most central member's `content`
- (b) top-3 members' `name` + `context`
- (c) top-5 members' full text
Measure: label quality (human rating), label word-count compliance, latency.

### E4: Batch vs. per-cluster labeling
Single call naming all clusters jointly vs. N parallel calls. Measure: distinctness, latency, collision rate.

### E5: Pool size
Facet over top-100, top-300, top-500. Measure: facet stability, coherence, latency.

### E6: Label model
Try Ollama `llama3.2:3b`, `qwen2.5:3b`, `gemma2:2b`. Measure: label quality, latency, compliance with single-word constraint.

### E7: Refinement consistency
Take a query, refine a bucket twice with same input. Measure: label overlap — how reproducible is refinement?

### E8: Fallback labeler
c-TF-IDF-only labeling vs. LLM. Measure: quality gap. If gap is small, LLM becomes optional.

## Success criteria

The feature ships when:
1. `lmgrep facet search` returns in <2s on this repo for top-300 pools.
2. Labels are single lowercase words in >95% of cases.
3. Subjective: on 10 test queries, the facet list "makes sense" to a human reviewer in ≥7 cases.
4. Refinement improves specificity (child labels are narrower than parent) in ≥7 cases.
5. Deterministic fallback (no LLM) still produces usable facets, even if labels are rougher.

## Out of scope for v1

- Multi-select facets
- Interactive TUI
- Exporting facet trees
- Parallelized refinement across all buckets
