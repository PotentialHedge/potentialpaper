# Handoff: signals, values that apps compute about papers

Status: plan, 2026-11-18. Nothing built yet.

## Goal

Anyone with a new way to reason about papers can publish it, and every reader, plugin and search can use it. A
**signal** is one value per paper that an app computes: an embedding of the abstract, a "rigour" score, a "uses
diffusion" label. Signals come in **sets**, one set per app: the site's own set, Benedict's, "user 1"'s. A plugin
reads any set, and so does search, so one person's idea becomes everyone's tool without touching the host.

## Decisions (made with Benedict, 2026-11-18)

- **A set is published like a plugin.** It is a public GitHub repo with a `potentialpaper-plugin.json` that declares
  its signals under `contributes.signals`. It is pinned to a commit and found through discovery like any plugin. A
  manifest may add only signals, with no panels: drop the "adds no panels or pages, so it never runs" warning for it.
  The set's id is the plugin id (`benedict-armstrong/paper-embeddings`). A signal's address is
  `<set id>:<signal>`, e.g. `benedict-armstrong/paper-embeddings:abstract`.
- **Kinds of signal:** `vector` (`dims` up to 2048, `metric` `cosine | dot | l2`), `number` (`min`, `max`, `higher`
  says which end is better) and `label` (a fixed list of values, one or several per paper). Each has a `title` and a
  `description` saying what it captures, which readers see wherever it is used.
- **Only the set's publisher writes its values.** The manifest names a `publisher`: an account handle. Committing that
  file to the repo is the proof that the repo's owner and the account agree, so no GitHub login is needed. That
  account makes a key scoped to the set (`/profile`, like API keys) and its backend writes with it. Nobody else can
  write to the set, so a bad set harms only the readers who chose it. This is "data for plugins D" with the host
  storing the data, not "C" (`handoffs/plugins.md`): shared data with one named owner, never data any client writes.
- **Values live in Postgres, not git.** They are an app's output, not a document or a claim (DESIGN.md §1). Rewriting
  them for a new model would put a commit on every page. They can't be rebuilt from git either: the publisher's
  backend can push them again, and the host keeps them as plugin storage is kept.
- **Who said it is always visible.** Every list, score and search result made from a signal names its set. A set is
  used in the UI only when the reader picks it, or when the site layer of settings turns it on (`signals.sets`).
- **Changing a signal's shape is a new signal.** A new `dims` or model means `abstract@2` beside `abstract`, and the
  publisher drops the old one when they are ready. Values carry the paper's `content_sha` they were computed from, so
  the host can show "computed before the last change" and the publisher can find stale ones.
- **Papers first.** Signals are for paper pages only in v1. The table keys by page, so other kinds can follow.

## Model

```
signal_sets      (id pk = plugin id, source, sha, publisher_account_id, manifest jsonb, created_at)
signals          (id serial pk, set_id, name, version, kind, spec jsonb, retired_at,
                  unique(set_id, name, version))
signal_values    (signal_id, page_id, content_sha, num real, labels text[], vec halfvec, updated_at,
                  pk(signal_id, page_id))
signal_keys      (like api keys, scoped to one set)
```

Vectors need pgvector: one partial HNSW index per vector signal, cast to its `dims`
(`CREATE INDEX … USING hnsw ((vec::halfvec(1024)) halfvec_cosine_ops) WHERE signal_id = 7`), made when the signal is
first written. A signal with fewer than a few thousand values is searched exactly. 10k papers × 1024 dims as
`halfvec` is about 20 MB a signal.

Limits: 20 signals a set, 2048 dims, a writes rate limit, and a total per set that admins can raise.

## API

- Write (set key): `PUT /api/v1/signals/<owner>/<set>/<signal>/values` with up to 500
  `{ paper, content_sha?, value }`, and `DELETE` for one paper or all.
- Read (public): a paper's values in a set; a set's signals with their coverage ("81% of ICLR 2027"); `nearest`
  (a paper or a vector, a signal, `k`, an optional scope); and the bulk read for a scope with an ETag, as in route B.
- RPC for plugins: `signals.get`, `signals.nearest`, `signals.scope`. Signals are public data, so no new permission.
- The changes feed already tells a publisher's backend which papers are new or changed.

## Search

- `sig:<set>:<signal>>0.7`, `sig:<set>:<signal>=diffusion` filter by a number or label, and
  `sort:<set>:<signal>` orders by it. Short names for the reader's chosen sets come later if the full ones are too long.
- `like:arxiv:2401.01234 via:<set>:<signal>` finds the papers nearest one paper.
- Free-text search by meaning needs the query embedded by the same model. A vector signal may name an `embed`
  endpoint on one of the manifest's `network` origins. The server sends it the query text, with a 2 s timeout and a
  cache, and searches with the vector it gets back. A signal without one supports `like:` only.

## Phases (one agent each; update this file at the end of yours)

1. **Sets and values, numbers and labels.** `contributes.signals` and `publisher` in the manifest (with the JSON
   Schema and `/plugins.md`), the tables, set keys on `/profile`, the write API, the public reads, and a "Signals"
   box on the paper page listing the reader's chosen sets' values.
2. **Vectors.** pgvector in dev and prod (see open questions), the indexes, `nearest`, and a picker on the
   related-papers panel: "by readers" (co-views) or by any vector signal the reader chose.
3. **Plugins.** The RPC methods, the bulk read, and the SDK types.
4. **Search.** `sig:`, `sort:`, `like: … via:`, and the `embed` endpoint.
5. **The site's own set and an example.** `potentialpaper/core:abstract`, filled by an outbox consumer like
   `search-index.ts` and turned on in the site layer, and `examples/signals/` with a small backend that publishes a
   number signal, like `examples/plugins/notes-backend`.

## Open questions

- **pgvector on Postgres 19.** Prod runs 16, where the `pgvector/pgvector:pg16` image is a drop-in. Dev runs
  `postgres:19rc2`, which needs pgvector built into a small image of our own, or dev goes back to 16 until 19.0.
- **Which model for the site's own set,** and where it runs: an API (cost per paper) or a small local model in the
  worker.

## Log
