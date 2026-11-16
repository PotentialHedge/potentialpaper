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
  (poll set to 60 s). Checks: lint, format, typecheck pass; 529 of 535 tests pass, the 6 failures being the known
  poppler ones in `pdf-ingest.test.ts`.
- Changed from the plan: the cursor is `(last_xid, last_event_id)` rather than `last_event_id` alone. Instead of a
  per-page `seq` table, a page's events within a batch are folded to the newest, and `handle` must be idempotent,
  as the plan says. Events of a deleted paper go with it (`on delete cascade`), so a consumer never hears of the
  deletion. Its own rows should reference `papers` with `on delete cascade` too.
- Not done: no dev systemd unit for the worker (no consumers yet). Phase 4 should add one, or run
  `npm run consumers:work` beside the dev server. Production needs `dc --profile tools up -d worker` on the next
  deploy (migration `0026` first).

### Phase 3 (2026-11-16, branch `data-model-phase-3`)

- **Registry:** `PAGE_SCHEMAS` (`src/server/pages/schemas.ts`) is the file type registry. Each entry keeps its zod
  schema, `glob`, `filesRegex` and `writable`, and gains `index(file, path) → IndexedDoc[]` (`{ kind, text,
fields }`, the shape Phase 4's `search_docs` rows can take) and `render: { panel, slots }`, naming the built-in
  panel that shows the type and its slots. That is data only for now: `slots.tsx` doesn't read it yet.
  `fileTypeOf(path)` and `indexFile(path, text)` are the entry points for the search consumer. Indexers exist for
  link, version, thumbnail (`picture`), submission and note. pdf and forms have none.
- **Review types** (`src/lib/review-files.ts`, pure): `submission.json` (`"schema": "submission/1"`: id, venue
  `{id,name,url}`, number, status, decision, optional `version` (a `v_` id), url, license), `forms.json`
  (`forms/1`: `forms` as `VenueForms`, url, license) and `notes/<id>.json` (`review/1`: id, replyTo, kind
  (`NOTE_KINDS`), invitation, signature, content (`FieldValue`s), createdAt, optional modifiedAt, url, license).
  URLs must be https. Folder and file names are the source's ids **lower-cased** (DESIGN.md says lower-case slugs,
  and OpenReview ids are mixed case). The exact id is inside the file, and the name isn't checked against it.
  `fetchedAt` is deliberately **not** in the files, so a re-import that finds nothing changes nothing.
  Helpers: `submissionFilePath`, `formsFilePath`, `noteFilePath`, `encodeReviewFile`, `parseReviewFile`,
  `noteFromFile`.
- **Rules** (`rules.ts`, `check.ts`, so web edits and pushes alike): the layout takes only those three files under
  `reviews/<source>/<submission>/`. `pathDenied` lets through admins and a role whose `grants` cover the path
  (`grantCovers`), so not the system, people or authors. A forms or note file needs its folder's
  `submission.json`. Review files have their own limits (`MAX_REVIEW_CHANGES` 1000 a commit,
  `MAX_REVIEW_FILES` 3000 a page) besides the 50/1000 for everything else. `receive.ts`'s tree walk is capped at
  the sum.
- **Bots:** a bot is an account with `is_bot` (as bot accounts already were), and its grants are rows in
  `bot_grants(account_id, pattern, shown, granted_by, created_at)`. `rolesOf` loads them for bot accounts. For
  now a grant can only be `reviews/<source>/**` (`grantProblem`). Migration `0027_bot_grants` creates the
  **`openreview` bot account** and grants it `reviews/openreview/**` (shown). `openreview` is added to the
  reserved handles. `src/server/bots.ts` has `OPENREVIEW_BOT`, `botActor`, `ensureBot`, `grantBot`, `revokeGrant`
  and `listGrants`. `npm run bots:grant` is the admin script (DEPLOY.md, "Bots and their grants").
- **Schemas served:** `/schemas/submission.json`, `/schemas/forms.json` and `/schemas/note.json` (the route reads
  the registry), and the editor extension's `jsonValidation` picks them up from `write-page-schemas.ts`. Its
  skeletons now prefill a `const` (`"schema": "review/1"`) and start objects as `{}`. `prek.toml` doesn't check them
  (`writable: false`), so it is unchanged and pages need no `pages:add-starter`.
- **Tests:** `tests/unit/review-files.test.ts` (paths, grants, validation messages, registry, JSON Schema) and
  `tests/integration/review-files.test.ts` (the bot commits through `commitPage`, a raised score is a one-file
  commit, re-committing the same is `unchanged`; people, other bots, the ungranted bot and the system are refused;
  an orphan note and an unknown schema version are refused; admins may; revoking stops the bot). Checks: lint,
  format, typecheck pass, and 539 of 545 tests pass. The 6 failures are the known poppler ones.
- **Changed from the plan:** "the system's openreview grant" is an `openreview` **bot account** with a grant row,
  not the system actor, so our importer goes through exactly the route an outside bot will. Its commits carry
  `Bot: true` and its `u_` id as author. No separate bot-id trailer was added, since the author id already names
  it. The registry stays JSON-only: sections, the picture, the PDF and demos aren't entries yet.
- **Left for Phase 4/5:** sections need an indexer (they aren't JSON; add a non-JSON entry or index them in the
  consumer). `slots.tsx` doesn't read `render` yet. Per-bot rate limits aren't built: a backfill must pass
  `rateLimit` to `commitPage`, since `COMMIT_RATE_LIMIT` (burst 30, 0.2/s) applies to bot accounts. Production
  needs migration `0027` on the next deploy.

### Phase 4 (2026-11-16, branch `data-model-phase-4`)

- **`search_docs`** (migration `0028_search_docs`): `(paper_id, path, n)` primary key, `blob_oid`, `kind`, `scope`
  (`page` | `reviews`), `text`, `fields`, and `tsv` generated from `text` (GIN). Cascades with the paper.
- **The `search` consumer** (`src/server/search-index.ts`, registered in `CONSUMERS`): lists the head's files, keeps
  rows whose path still has the same blob id without reading the file, deletes rows of changed or vanished files,
  and indexes the rest through `indexFile`. Empty blobs (the dozen starter sections) are never read. One advisory
  lock per page. `reset` truncates the table, so `consumers:rebuild -- search` re-indexes everything (do that after
  changing an indexer).
- **Registry:** `PAGE_SCHEMAS` gains `section`, a `format: 'text'` entry (schema `z.string()`, pattern
  `{author,community}/NN-slug.{md,html}`), whose indexer strips markup (`sectionText`) and records `part` and
  `title`. Every indexed type now names its `scope`; `searchScopeOf(path)`. JSON-only consumers (the `/schemas/`
  route, `write-page-schemas.ts`, `prek.toml`) go through `PAGE_SCHEMA_NAMES`, so nothing about them changed.
  Versions' documents now carry `label` too.
- **Query** (`lib/query.ts`): `in:paper` (default), `in:page`, `in:reviews`, `in:all` (aliases `review`, `pages`,
  `title`, `abstract`…); several add up; a scope is not a term (doesn't count toward the 8) and applies to the whole
  query. Unknown or negated scopes are dropped with an error. `positiveText(node)` collects the words to mark.
- **Search** (`server/search.ts`): a text term matches titles/abstracts (`papers.search`) and/or a file in scope,
  where all its words must be in one file. Negation, `OR` and field filters work as before. Relevance stays
  `papers.search`'s rank when titles are searched, plus the best matching file's `ts_rank_cd` when files are, so a
  files-only search ranks by them. The misspelled-title fallback only runs when titles are searched. Each hit has
  `matches` (best 3: path, kind, label, `ts_headline` snippet with U+E000/U+E001 around matched words) and
  `matchCount`; the API's `SearchResponse` includes both. The home page shows them under each row
  (`components/paper/SearchMatches.tsx`), and the syntax help lists the scopes.
- **Dev:** both databases migrated; the dev worker runs as the transient user unit `papertrail-worker` (log
  `data/worker.log`, recipe in DEPLOY.md "Outbox consumers"); it indexed the dev DB's 2,010 events (2 sections, 7
  versions; no reviews until Phase 5). Not kept across a reboot, like `papertrail-dev`.
- **Tests:** `tests/unit/search-scopes.test.ts` (scopes, `positiveText`, the section type, snippets) and
  `tests/integration/search-docs.test.ts` (indexing, edits and deletions, unchanged blobs not re-read, rebuild,
  every scope, negation/OR/filters, no fuzzy fallback in files). Checks: lint, format, typecheck pass; 557 of 563
  tests pass, the 6 failures being the known poppler ones.
- **Changed from the plan / decided here:** a plain search (no `in:`) still looks only at titles and abstracts, so the
  home page behaves as before and reviews don't flood it; files are searched on request. Easy to flip
  (`DEFAULT_SCOPES` in `lib/query.ts`) if Benedict wants files in by default. `search_docs` has `scope` and `n`
  beyond DESIGN.md's column list (one file may give several documents). Matches aren't links to the exact spot yet:
  they name the file under the paper's row, which links to the paper.
- **Left:** production needs migration `0028` and the `worker` service (`dc --profile tools up -d worker`), which
  then replays every page's events into the index once. Score filters (`rating>=8`) are still "Later". With ~126k
  notes after Phase 5, check `in:reviews` timing on the relevance sort (a correlated `max(ts_rank_cd)` per matching
  paper); a `kind:` filter would be easy to add on the `kind` column. `slots.tsx` still doesn't read `render`.

### Phase 5 (2026-11-16, branch `data-model-phase-5`)

- **The importer is the `openreview` bot** (`src/server/import-reviews.ts`): for each submission it builds the
  folder's files (`submissionFiles`: `submission.json`, `forms.json`, `notes/<id>.json`), compares their blob ids
  with what the head holds under that folder (`readFolder`, new in `pages/repo.ts`, which reads only the trees on
  the way), and commits the difference through `commitPage` as the bot, deleting notes the source no longer
  lists. Nothing differs, nothing is committed (and no rate-limit token is spent). One commit per submission,
  summary `Import ICLR 2027 submission <id>: 3 notes` / `Update …: 1 note, 1 removed`, with the forum as evidence.
  It runs at `IMPORT_RATE_LIMIT` (passed as `rateLimit`), `concurrency` pages at once, retries `page_busy`, follows
  merges (`findPaper`), and reports refusals instead of stopping. The importer no longer writes `submissions`,
  `submission_notes` or `venues` at all.
- **`npm run papers:import-reviews -- <scrape> <group> <name> [--concurrency 4] [--from <forum>]`**: resumable by
  running it again (unchanged folders are skipped by blob id, ~1,000 a few seconds); `--from` skips ahead.
  `fetchedAt`/`meta` are no longer read.
- **The `reviews` consumer** (`src/server/review-projection.ts`, second in `CONSUMERS`): reads the head's
  `reviews/` folders, every review blob in one query, and per page (advisory lock) upserts the venue
  (`<source>:<venue id>`, forms from `forms.json`), upserts each submission, replaces its notes, and deletes the
  page's submissions whose folder is gone. `fetched_at` is now when the folder last changed (newest
  `page_revisions` row up to the head touching it), since a re-import that finds nothing commits nothing; the
  panel's "Updated" means that. `reset` truncates `submissions` and `submission_notes` (venues stay).
  `submissionsOf` and the Submissions panel are unchanged.
- **Backfill in dev** (user unit `pp-reviews-backfill`, log `data/reviews-backfill.log`): the dev DB had no
  submission rows and 501 repos. 42,430 submissions from `../papermarket/research/data/iclr2027.sqlite` in 1,230 s
  at concurrency 4: 42,425 with a paper (40,775 commits; 1,650 were already there from a trial run), 5 without,
  0 refused, **286,227 notes** (the plan's ~126k was low: the scrape has ~285k public replies). Repos went
  501 → 42,438. Then the worker: `search` indexed everything (328k review documents in `search_docs`, ~20 min),
  and `reviews` projected 42,425 submissions and 286,227 notes (matching the import exactly; one venue with its
  forms; ~50 min at ~15 pages/s on a host busy with other work). Then `REPACK (CONCURRENTLY)` and
  `VACUUM (ANALYZE)` on the page, search and review tables (`data/repack.log`); little to reclaim, since
  everything was inserted, not rewritten.
- **`in:reviews` timing:** the relevance sort's correlated `max(ts_rank_cd)` per matching paper took 2–4 s for
  common words. Now `fileRanks` joins one grouped pass over the matching documents (`server/search.ts`): `in:reviews
diffusion` (6k papers) ~1 s, `transformer attention` ~0.5 s, `novelty -diffusion` (19k papers) ~1.6 s, on a
  loaded dev host with the worker running. Words in nearly every review stay slow-ish; a `kind:` filter or
  capping candidates would be next if it matters.
- **Sizes (dev, after):** `search_docs` 1.9 GB (text 615 MB, tsv 811 MB, GIN 255 MB): the note text is kept for
  snippets. `page_objects` 1.2 GB, `submission_notes` 0.8 GB; the database 4.4 GB. Production grows by about the
  same (it already holds the notes once, in the old rows).
- **Tests:** `tests/integration/submissions.test.ts` rewritten: files committed as the bot and projected; a
  re-import commits nothing; a change commits only the changed files and deletes a dropped note; lower-cased
  folder names with ids kept inside; `fetched_at` from the folder's last change; a folder taken down removes its
  rows; rebuild; merges. Checks: lint, format, typecheck pass; 561 of 567 tests pass, the 6 failures being the
  known poppler ones. Two things seen on the way: (1) running the suite while a backfill commits into the same
  Postgres cluster fails the consumer tests, since the watermark (`pg_snapshot_xmin`) is cluster-wide and keeps
  moving; run tests on a quiet cluster. (2) `tests/unit/page-git.test.ts` "does not depend on which side is
  ours" is a fast-check property that failed once with `mergeFile('\na', '', '\n')` ≠ `mergeFile('\na', '\n', '')`
  (`''` vs `'\n'`): a real, rare asymmetry in `merge.ts`, unchanged since before this plan, not fixed here.
- **Changed from the plan:** `import-submissions.ts` still only creates `papers` rows: a paper's identity isn't
  review data, and the files need the submission's number and status, which the reviews import has. The order
  "write files, then stop writing tables" became one step, since the dev tables were empty and nothing is live.
- **Left / production on deploy** (in order): migrations `0026`–`0028` (no new migration in Phase 5); the
  `worker` service (`dc --profile tools up -d worker`); the backfill as a detached job,
  `dc run -d tools npm run papers:import-reviews -- <scrape> ICLR.cc/2027/Conference "ICLR 2027"` (the scrape has
  to be on the server; ~20 min), during which pages with events but no review files yet show no submissions
  until it and the worker are through; then `VACUUM (ANALYZE)` (and `REPACK` once on 19). Postgres 19 itself
  once 19.0 is tagged (DEPLOY.md, "Postgres 19"). Not built: ICLR 2026 reviews (forms ready, scrape exists), the
  per-bot rate limits as rows, `slots.tsx` reading `render`, and the worker running pages of one consumer in
  parallel (the projection does ~15–40 pages/s, so a full rebuild of 42k pages is 20–50 min).
