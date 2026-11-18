# Handoff: signals, values that apps compute about papers

Status: 2026-11-18. Built and deployed: sets, values in generations, the public reads and the plugin RPC (Phase 1
and the reads of Phases 2 and 3, without pgvector), and the first set, `benedict-armstrong/acceptodds-map`, which the
Paper map plugin draws, and the events feed for publishers. Not built: staleness (`inputs`), search, pgvector, the
site's own set. See the Log.

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

### 2026-11-18: signals on the site, the acceptodds map as the first set

- **Decided with Benedict:** the map's publisher sends each paper's `map.xy`, `map.region`, `map.cluster` and a
  64-dimensional `embedding`; the host computes no layout. The map is a plugin on Benedict's GitHub like score
  standing. ICLR 2027 only for now. The copy reads acceptodds' database directly on ben-docker-1.
- **Host** (`server/signals.ts`, `server/api/signals.ts`, migration `0044_signals`): `signal_sets`, `signals`,
  `signal_labels` and `signal_values`, keyed by the paper identifier the publisher gave and matched to papers when
  read. A label signal's titles are per generation (a map's regions change with each rebuild). Writes need a verified
  account or an API key that may write, and the account the manifest names as `publisher`. Routes under
  `/api/v1/signal-sets` (register, set, `columns`, `nearest`, `values`, `labels`, `generations`, `…/publish`) and
  `/api/v1/pages/{identifier}/signals`. `columns` is kept in memory by ETag, which also turns every ten minutes as new
  papers match values. `nearest` scans the vectors in memory (no pgvector yet: about 2 s cold for 42k × 64).
  RPC `signals.sets`, `signals.set`, `signals.columns`, `signals.nearest`, `signals.forPaper`, no permission;
  `pp.signals` in the SDK; a Signals section in `/plugins.md`. Manifest: `publisher`, `contributes.signals`.
- **The set** `github.com/benedict-armstrong/potentialpaper-acceptodds-map`, published by the bot `acceptodds-map`
  (so its key writes signals and nothing else). `sync.mjs` runs in a container on ben-docker-1
  (`~/projects/potentialpaper-acceptodds-map`, `docker compose logs sync`) on acceptodds' database network, as the
  role `potentialpaper_reader`, which may only read `map_points`, `map_topics` and `listings`. Every 30 minutes it
  copies the map whole as a new generation if it changed. Its two secrets are in `sync.env` there. 42,429 points;
  42,425 match papers here.
- **Next:** the events feed for publishers (the decided design: oldest first from a cursor, following the
  transaction as `consumers/run.ts` does, plus events for merges and PDFs), `inputs` and a stale list, search
  (`sig:`, `sort:`, `like: … via:`), pgvector once production is on Postgres 19, NeurIPS 2026 (acceptodds has its map
  too, as its own signals since its layout is separate), and the site's own set.

### 2026-11-18: the map under many readers

- **Edge cache:** a Cloudflare cache rule (zone papers.potentialhedge.com, `http_request_cache_settings`) caches GETs
  of `/api/v1/signal-sets*` and `/api/v1/pages/*/signals` with the origin's TTLs: 5 minutes for `columns` and
  `nearest`, 1 for the rest. A set's new generation shows within 5 minutes.
- **`nearest … with`:** `with=map.xy,map.cluster` (up to 10 signals) returns those values for the paper and each
  neighbour, and the titles of their labels. The ranking keeps a small sorted list in one pass instead of sorting
  every paper. The minimap (plugin v0.4.0) draws from two such reads, `map.xy` k=100 and `embedding` k=10, a few KB
  each, instead of the whole map's columns (1.9 MB).
- **`page.hasSignals`:** a when-key for papers and scopes, true where some set has live values for the paper or one
  of the scope's papers; kept 10 minutes per page. The map's panels show only there.
- **`ui.setPath`:** a plugin page sets the rest of its address without a reload; the map page names the selected
  paper, so a link opens on it.

### 2026-11-18: the events feed

- `GET /api/v1/events?after=<cursor>&kind=paper&limit=100&wait=25` (`server/events-feed.ts`, `server/api/events.ts`):
  every commit, oldest first, read as the consumers read (`xid` order, only transactions that have ended), so none is
  skipped. The cursor is `<xid>-<id>`; with nothing more ready, `next` is the horizon (the oldest running
  transaction, id 0). `after=now` starts at the present. Kinds are filtered after reading at most 2,000 events, so a
  narrow filter still answers quickly and moves the cursor on. `wait` (up to 25 s) holds the request on one `LISTEN`
  connection a process (`listen` from `consumers/worker.ts`) and looks again every 5 s. Never cached.
- Each event: the page with a paper's every identifier, `seq`, `oid`, `parent`, `paths`, `summary`, `bot`, `created`
  (first commit) and `merged` (the merge commit now names the paper folded in: `mergedFrom` in its payload, set by
  `mergePapers`). Papers are never deleted; topic and org pages that are deleted take their events with them.
- `examples/signals/follow.mjs`: a follower that keeps a cursor file and writes values in batches. OpenAPI and the
  Signals section of `/plugins.md` describe it.
- **Next:** staleness (`inputs` on a signal, the commit a value was computed at, `GET …/stale`), pgvector on
  Postgres 19, search.
