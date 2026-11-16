# Handoff: the repo as the data, bots that write it, search over it, and room to scale

Read `handoff.md` first (stack, deploy, how to work with Benedict), then `DESIGN.md` §3, §4.3, §4.4, §4.8–4.11 and
§10 ("Server-side extensions: bots"). Work on a branch per phase, commit and push after each working step, no Claude
attribution in commits. Pre-launch: breaking changes and data resets are fine. Don't screenshot or preview the UI;
Benedict looks himself.

## Goal

Anyone can extend the site by writing a bot that commits typed files into paper pages, and a plugin (a renderer for a
type of file) shows them. Everything in a repo is searchable. Built for one server, with seams so that storage, derived
data and search can each be scaled later without a rewrite.

## Decisions (made with Benedict, 2026-11-16; don't reopen)

- **Imported submissions and reviews go into the page repo**, under `reviews/<source>/<submission>/`
  (`submission.json`, `forms.json`, `notes/<id>.json`), written only by the bot granted `<source>`. Why: score changes
  and edits get real history, and a third party's bot can import a journal's reviews the same way we import
  OpenReview's. The `submissions`/`submission_notes`/`venues.forms` tables become a projection of those files.
- **File types are the contract** between bots and plugins: path pattern, zod schema (versioned in the file, e.g.
  `"schema": "review/1"`), indexer, renderer. Extend `server/pages/schemas.ts`'s `PAGE_SCHEMAS`; don't build a second
  registry.
- **Bots work like GitHub Apps:** registration with write grants on path patterns (rows, checked in `rules.ts`), admin
  grants by script, short-lived tokens, per-bot rate limits, `Bot: true` and the bot id in trailers, webhooks with
  delivery ids. Our OpenReview importer is the first bot and must use the same route.
- **Only `page_current` (and what the page shows) is written in the commit's transaction.** Search, review tables,
  webhooks and feeds are consumers of `page_events`: a cursor each, idempotent "bring page P to head H", rebuild =
  cursor to zero.
- **Search** is `search_docs(paper_id, path, blob_oid, kind, text, fields, tsv)`, Postgres full text, keyed by blob
  id, queried only through `server/search.ts`.
- **Scaling seams, built now:** all object access through `GitRepo`; every table keyed by `paper_id` first and one repo
  per transaction; derived data via the outbox; search behind one module; types and grants as data. **Not now:** queues,
  sharding, packs in R2, an external search engine.
- **Postgres 19** (GA 2026-11-19), from 16.

## Phases (one agent each; update this file at the end of yours)

### Phase 0: Postgres 19

- Dev now on `postgres:19rc2`, production on `postgres:19` once 19.0 is tagged (2026-11-19 or later). Pin the exact
  version in both compose files.
- **The volume mount moves** from `/var/lib/postgresql/data` to `/var/lib/postgresql` (the image keeps data under
  `/var/lib/postgresql/<version>/docker` since 18). Mounting the old path silently writes into the container.
- Dump with `pg-backup.sh` (or `pg_dumpall`), restore into a **new** volume, keep the old volume until the site checks
  out. The restore rebuilds the full-text and `pg_trgm` indexes, which 19's release notes ask for.
- Add to the Postgres `command`: `autovacuum_max_parallel_workers` (off by default). Check `max_locks_per_transaction`
  (default now 128) and that nothing needs JIT (now off).
- Run the full checks and migrations against 19; update `handoff.md`'s stack line and DEPLOY.md.

### Phase 1: one object store interface

- Every read and write of `page_objects` goes through `GitRepo` (`server/git/repo.ts`). Today `pages/repo.ts`,
  `pages/clone.ts`, `pages/commit.ts` and `demos/attach.ts` query it directly.
- No behaviour change; tests against `memoryRepo` and Postgres both pass. This is the seam for moving bodies to R2 later.

### Phase 2: outbox consumers

- A `consumer_cursors(name, last_event_id, …)` table and a small framework: a consumer is
  `{ name, handle(paperId, head) }`, idempotent per page.
- Mind the outbox's note in `schema.ts`: ids are handed out before commit, so a lower id can appear late. Use a
  watermark (don't advance past ids of transactions still in flight) or re-check by per-page `seq`; test it.
- A `worker` compose service (like `ingest`), woken by `LISTEN/NOTIFY` from `commitPage`, polling as a fallback.
- `npm run consumers:rebuild -- <name>` resets a cursor.

### Phase 3: file types and the review layout

- Extend `PAGE_SCHEMAS` into the registry (indexer and renderer hooks beside the schema). Add `submission`, `forms` and
  `note` (`review/1`) types from the shapes in `lib/submissions.ts` (`NOTE_KINDS`, `FieldValue`, `VenueForms`), each
  carrying `license` and `url`.
- Path rules for `reviews/<source>/**`; a `bot_grants` table; the system's `openreview` grant.
- JSON Schemas served at `/schemas/<name>.json` as the others are, so outside bot authors can validate.

### Phase 4: search over everything

- `search_docs` and its consumer; sections, links, versions and notes as the first indexed types.
- `server/search.ts` and `lib/query.ts`: scopes (`in:reviews`, `in:page`), hits that name the file. Keep paper ranking on
  `papers.search`.

### Phase 5: the OpenReview importer as the first bot, and the backfill

- `import-reviews.ts`/`import-submissions.ts` write files through `commitPage` as the `openreview` bot, committing only
  when something changed.
- The review projection consumer rebuilds `submissions`/`submission_notes` (and venue forms) from the files; the
  Submissions panel reads the projection as before.
- Backfill: ~42k ICLR 2027 submissions, ~126k notes (~280 MB of JSON) into their repos. Run it with
  `systemd-run --user` (sessions kill `nohup` jobs), resumable, and `REPACK`/`VACUUM` after.
- Then the importer stops writing the tables directly.

### Later (not this plan)

- Bot registration for outsiders, tokens and webhooks: with Milestone 7 (IMPLEMENTATION.md).
- Renderers from extensions, and readers turning built-in ones off: with Milestone 8.
- Score filters in search (`rating>=8`) from fields forms mark as scores.
- Backfilling review history from before our first import (OpenReview's note edits).

## Log

(Each phase adds what it did, what it changed from the plan, and what's left.)

**How the phases run:** one T3 thread per phase, on its own branch (`data-model-phase-<n>`), cut from the previous
phase's branch so this file stays current. Commit and push after each working step. At the end, add your entry
below and launch the next phase's thread pointing at this file. Merging into `main` waits for Benedict.

### Phase 0, dev half (2026-11-16, branch `data-model-phase-0`)

- Dev is on `postgres:19rc2` with `autovacuum_max_parallel_workers=2`, volume `pgdata19` mounted at
  `/var/lib/postgresql`. Dumped with `pg_dumpall` (`data/pg19/dev-pg16.sql`, gitignored) and restored into the new
  volume. The old `potentialpaper-dev_pgdata` (16) is kept. `max_locks_per_transaction` is 128, and nothing uses JIT.
- There is no `pg-backup.sh` in this repo (DESIGN.md names acceptodds'), so it was `pg_dumpall` straight.
- Migrations and checks on 19: lint, format, typecheck pass; 516 of 522 tests pass. The 6 failures are all in
  `tests/integration/pdf-ingest.test.ts` and fail the same way on 16: the host has no poppler (`pdftotext`). Not
  related to this work; running them needs poppler on the host, or the tools image.
- **Left: production**, once 19.0 is tagged (2026-11-19 or later). The steps are in DEPLOY.md, "Postgres 19".
  It doesn't block Phases 1 to 5.

### Phase 1 (2026-11-16, branch `data-model-phase-1`)

- `src/server/git/repo.ts` is now the only code that touches `page_objects`. `GitRepo` gained `sizes(oids)` (byte
  sizes without reading bodies, for the demo limits); `WritableGitRepo` adds `write(objects)` (insert, ignoring
  objects already there). `pageRepo(tx, paperId)` is writable when handed a `Writer`, read-only for a `Reader`
  (overloads); `memoryRepo` is writable too, and keeps writes apart from the map it was given, since the
  protocol tests mutate that map and expect the repo to see it.
- Moved onto it: `readObject` (`pages/repo.ts`, so every `readCommit`/`readFiles`/`readText` caller), the dumb
  protocol's loose objects (`pages/clone.ts`), `recordCommit`'s object writes (`pages/commit.ts`) and the demo size
  check (`demos/attach.ts`). Nothing else in `src/` or `scripts/` queried the table. `readHead` and `toBytes` moved
  into `git/repo.ts` (re-exported from `pages/repo.ts`), which also removes the runtime import cycle between them.
- Changed from the plan: nothing in substance. The dumb protocol's object request is now two queries (identifier,
  then the object) instead of one join. Refs are still written by `moveHead` in `commit.ts` directly; the plan keeps
  refs in `page_refs`, so that is left as is.
- Tests: `tests/integration/git-repo.test.ts` runs the same checks on `memoryRepo` and Postgres. Integration tests
  still read `page_objects` directly to assert on storage; that's deliberate. Checks: lint, format, typecheck pass;
  521 of 527 tests pass, the 6 failures being the known poppler ones in `pdf-ingest.test.ts`.
- Left: nothing for Phase 1.

### Phase 2 (2026-11-16, branch `data-model-phase-2`)

- **Framework** in `src/server/consumers/`: a consumer is `{ name, handle(paperId, head, { database }), reset? }`
  (`types.ts`), registered in `CONSUMERS` (`index.ts`, empty until Phases 4 and 5 add search and the review
  projection). `runConsumer` (`run.ts`) brings one up to date in batches of 500, handing each page over once per
  batch at its last event's head; `rebuildConsumer` calls `reset` and sets the cursor back to zero.
- **Late ids: a watermark on transactions.** Migration `0026_consumer_cursors` adds `page_events.xid` (`xid8`,
  default `pg_current_xact_id()`, index on `(xid, id)`) and `consumer_cursors(name, last_xid, last_event_id,
leased_until, last_error, failed_at, updated_at)`. A consumer reads only events with
  `xid < pg_snapshot_xmin(pg_current_snapshot())`, in `(xid, id)` order, and the cursor is the last `(xid, id)`.
  Everything below the oldest running transaction has ended, and new transactions get higher xids, so nothing can
  appear behind the cursor. The cost: a long transaction that has written anything holds every consumer back until
  it ends (it only delays them). The cursor also survives `page_events`' identity being reset.
- **Failures and concurrency:** a page that throws stops its consumer just before that page's first event in the
  batch. The error goes into `last_error`, and it retries after a minute. A lease (`leased_until`, which is also
  the token) keeps two workers off one consumer. A rebuild clears the lease, so a worker mid-run stops at its next
  step (`lease-lost`).
- **Waking:** `recordCommit` runs `pg_notify('page_events', paperId)` inside the commit's transaction (delivered
  only on commit, pushes included). The worker (`worker.ts`, `npm run consumers:work`) runs every consumer until it
  catches up, then waits for a notification or 15 s. Its `LISTEN` connection reconnects after a failure.
- **Ops:** `worker` compose service (tools image, `profiles: [tools]`, like `ingest`), DEPLOY.md "Outbox
  consumers", the recipe's `up -d ingest worker ssh`. `npm run consumers:rebuild -- <name>`. With no name, it
  lists the consumers and their cursors.
- **Tests** (`tests/integration/consumers.test.ts`, 8): newest head once per page, batching, an open transaction
  holding a lower id back (a later commit isn't read past it), an older transaction with a higher id coming first,
  failure/wait/retry, the lease and a rebuild during a run, rebuild replay, and the worker woken by a real commit
  (poll set to 60 s).
- Changed from the plan: the cursor is `(last_xid, last_event_id)` rather than `last_event_id` alone. Instead of a
  per-page `seq` table, a page's events within a batch are folded to the newest, and `handle` must be idempotent,
  as the plan says. Events of a deleted paper go with it (`on delete cascade`), so a consumer never hears of the
  deletion. Its own rows should reference `papers` with `on delete cascade` too.
- Not done: no dev systemd unit for the worker (no consumers yet). Phase 4 should add one, or run
  `npm run consumers:work` beside the dev server. Production needs `dc --profile tools up -d worker` on the next
  deploy (migration `0026` first).
