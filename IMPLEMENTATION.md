# PotentialPaper — implementation plan

A rough order of work for [DESIGN.md](DESIGN.md). Sizes are relative (S, M, L), not estimates. Each
milestone ends with something you can use and goes through `/api/v1` from the start.

## Sequence

| #   | Milestone                  | Size | Ends with                                       |
| --- | -------------------------- | ---- | ----------------------------------------------- |
| 0   | Skeleton                   | S    | Site deployed to staging, sign-up works         |
| 1   | Papers, read-only          | M    | `/abs/<id>` works for any arXiv paper           |
| 2   | Git store                  | M    | Scripted edits with history; `git clone` works  |
| 3   | Community editing          | L    | **Private alpha:** people edit and patrol pages |
| 4   | Labeled links              | L    | Link graph is usable                            |
| 5   | Authors                    | L    | Authors claim and fill in their section         |
| 6   | Comments and notifications | M    | **Public launch**                               |
| 7   | Published API and webhooks | S    | Outside bots can build on it                    |
| 8   | Extensions v0              | L    | First third-party extension runs                |

## 0. Skeleton

- `git init`, Next.js 16, Drizzle, Tailwind, Vitest, ESLint, Prettier, CI.
- Copy from [acceptodds](https://github.com/PotentialHedge/acceptodds): tokens and `ui.ts`, compose
  files and Dockerfile, auth, onboarding, affiliations, and the institution allowlist with its curated
  file and build script. Remove everything to do with trading.
- Accounts with a handle, optional real name and an explicit choice about showing the institution.
- Read the Next.js docs in `node_modules/next/dist/docs/` first; acceptodds' `AGENTS.md` warns that
  this version breaks older assumptions.
- `institution_domains` table for domains an admin adds by hand. No request form or admin UI.
- Set a strict CSP. Staging can use a temporary domain, since the name isn't final.

## 1. Papers, read-only

- `papers`, `paper_identifiers`, arXiv and OpenAlex or Crossref adapters, on-demand creation with
  rate limits and cached misses.
- `/abs/<id>` and `/doi/<id>`, built from named slots, with empty author and community sections.
- Search with Postgres full text and `pg_trgm`.
- Edge caching with viewer state in client islands. **Verify this early**, because it shapes how
  every later page is built.
- Import ICLR 2027 from `../papermarket/platform/data/` as the first corpus.

## 2. Git store

Most of the risk is here, so it comes before the editor.

- Object hashing and tree building; `page_objects`, `page_refs`, `page_revisions`, `page_current`.
- `commitPage`, with path permissions, compare-and-swap and event outbox.
- Three-way merge, diffs, revert. Rebuild-projections script.
- Dumb-HTTP clone route.
- **Tests:**
  - Each generated repo passes `git fsck --strict` under fast-check (random paths, non-ASCII, empty files).
  - Fifty concurrent commits to one page: a linear history with none lost.
  - Dropping the projections and rebuilding them gives identical rows.

## 3. Community editing

- Section editor with preview, summary and conflict UI; Markdown rendered and sanitized at commit.
- History, diff and revert pages.
- `/changes`, watchlist, digest mail, protection levels, new-account rate limits, reports, blocks.
  Built ahead of the rest (2026-11-17, `handoffs/pages.md` Phase 5): `/changes` (and `GET /api/v1/changes`) and
  per-page protection levels (`established`, `admins`; `npm run pages:protect`).
- Redaction script and its public log.
- **Blocker for the alpha: choose the contribution license** (design section 12, still to discuss).
- Alpha with a few dozen invited researchers, in one field, on ICLR papers. Most of what matters is
  learned here: do people edit, and does patrolling hold up?

## 4. Labeled links

- `links.jsonl` validation, label table, `page_links`, "add a link" form, backlinks on the target.
- Grouped link display, stances, neighbourhood graph, `/graph`.
- Citation import and the "How does this connect?" prompt.

Built ahead of the rest of this milestone (2026-11-16, `handoffs/pages.md` Phase 1): `links.jsonl` in each part,
the label table with `in-topic`, `page_links` and "what links here" on pages of every kind. The "add a link" form,
grouped display, stances and the graph are still to come.

## 5. Authors

- Claims: email in the paper, ORCID, co-author vouch, manual queue. Co-author notification and dispute.
- Author section editor, `resources.json` form, templates, R2 uploads, embed allowlist.
- Per-claim author identities: on their own paper, a confirmed author is always named and their handle
  never appears (design section 5.3). **Test this as an invariant:** public reads and clones of a paper
  never reveal the `u_` id of one of its confirmed authors after their claim.
- COI badges on edits and links.
- Try converting several real project pages to check it can actually replace them. If it can't,
  this milestone isn't finished.

## 6. Comments and notifications

- Threads on papers and links, mentions, author badges, moderation, anonymous per-paper aliases.
- Notifications, especially "someone linked to your paper".
- Before launch: final name and domain, terms, takedown process, legal review, backups and restore
  drill, public data dump.
- Launch alongside ICLR, with acceptodds paper pages linking across.

## 7. Published API and webhooks

- Freeze `/api/v1`, publish docs, add webhooks over the outbox, bot token flow.
- Bots as in DESIGN.md §10 ("Server-side extensions: bots"): registration, path grants, short-lived tokens,
  delivery ids. The groundwork (file types, outbox consumers, the OpenReview importer as the first bot) comes
  earlier, in `handoffs/data-model.md`.
- Write one small example bot, such as one that adds links from a replication dataset.

## 8. Extensions v0

- Manifest validation, SHA pinning, R2 snapshot, sandboxed host, `postMessage` RPC, permissions and
  consent, per-user install, kill switch.
- Move two built-in panels onto the extension API to prove it works. The Submissions panel, a renderer
  for `reviews/**` files (DESIGN.md §4.8), is a natural first.
- Start with a small set of slots. An acceptodds odds panel makes a good first extension.
- Planned in `handoffs/plugins.md`, brought forward. Built 2026-11-16 (its Phase 1): settings.json, layered
  defaults ← site ← user, with `/settings`, `GET`/`PUT /api/v1/me/settings` and `/schemas/settings.json`
  (DESIGN.md §10).
- Built 2026-11-16 (its Phase 2), the plugin host: manifest validation (`/schemas/plugin-manifest.json`), sources
  from GitHub pinned to a commit and copied to R2, a host per plugin on the content domain with its own CSP, the
  `postMessage` RPC checked against granted permissions, the SDK (`/sdk/v1/pp.js`), consent (`user_plugin_grants`),
  per-user install (the `plugins` key, `POST /api/v1/me/plugins`), `plugins.default` and the kill switch
  (`plugins.blocked`), per-user plugin storage, plugin panels in every kind's slots by `when` conditions, plugin
  pages at `/x/…`, dev plugins from localhost, and `examples/plugins/hello/`. Moving built-in panels onto the API
  waits for the data routes of Phase 4.
- Built 2026-11-16 (its Phase 3), discovery and the plugin pages: `GET /api/v1/plugins/discover` (repos with the
  topic `potentialpaper-plugin`), releases as tags with updates that ask again for new permissions
  (`/api/v1/me/plugins/updates`), `/settings/plugins` (installed, discover, add by source, load from localhost, each
  plugin's settings as a form), and `/plugins.md`, the guide for agents building one.
- Built 2026-11-16 (its Phase 4), data for plugins A and B: `scope_stats` (per scope, venue and score field: sorted
  means, bins, split by outcome; recomputed when the review projection and membership mark a scope, and rebuilt with
  `consumers:rebuild -- scope-stats`), `GET /api/v1/pages/{identifier}/scores[/{venue}/{field}]`, the bulk
  `GET /api/v1/pages/{identifier}/papers` (NDJSON), `scope.scores` and `scope.papers` over the RPC, the site setting
  `plugins.venueStats.hideUntil`, and `/openapi.json` for the public page routes.
- Built 2026-11-17 (its Phase 6), the first third-party extension runs: score standing,
  `github.com/benedict-armstrong/potentialpaper-score-standing` (v0.1.0), the histogram and curve of a venue's
  review scores on papers and venues, from `scope.scores` alone, with no host code of its own. Its org view can now be built:
  organisation pages have members (`handoffs/pages.md` Phase 4).
- Built 2026-11-17 (its Phase 5), plugins with their own backend (D): the `identity` permission
  (`pp.identity.token()`/`fetch`, ES256 tokens with a pairwise `sub`, audience the plugin's id, keys at
  `/.well-known/jwks.json`, `npm run identity:keys`), asked of every reader even for a site default, the manifest's
  `bot` in the approval prompt, `/plugins.md`'s "Your own backend", and `examples/plugins/notes` with its backend.
  Bot registration by outsiders, bot tokens and webhooks stay with Milestone 7.

## Pages above the paper

Planned in `handoffs/pages.md`: venues, topics, organisations and people as pages of their own, built like a
paper's. Phase 1 (the page model) is built: `pages`, the page store keyed by `page_id`, the kind registry
(`lib/kinds.ts`), path rules, commits, clone and push per kind, `page_members` and `page_ancestors`, and generic
routes and slots (`/v`, `/t`, `/o`, `/u`). Phase 2 (venue pages) is built: the `venues` bot (`npm run venues:sync`),
a series' editions, an edition's submissions by status with filters (`GET /api/v1/pages/{identifier}/venue-papers`),
and organiser claims (`page_claims`, `/claim/venue/<key>`). A venue's review scores (its `scores` panel) come from
`handoffs/plugins.md` Phase 4's `scope_stats`. Phase 3 (user pages) is built: every account's `/u/<handle>`, made and
moved with it (`page_redirects`), showing only what its `user.show.*` settings turn on (`server/user-pages.ts`), with
activity and comments under the handle, person links (`homepage`, `orcid`, `scholar`, `wrote`) and
`npm run users:pages`. Phase 4 (organisation pages) is built: the `orgs` bot (`npm run orgs:sync`, and on confirmed
addresses and ingest passes) makes institutions' pages from the allowlist with ROR ids (`config/institution-ror.json`,
`npm run institutions:build -- --ror-only`); members by confirmed address own `members/` and `org.json` and make
departments and labs (`/new/org/<key>`); an org's papers (`page_members` `via` `affiliation`) come from members'
claims when they show their institution and from domains printed on page 1, kept up by the worker's `org-members`
task, and roll up from departments; the page lists people who show it, and venues and topics by count
(`GET /api/v1/pages/{identifier}/org`). `show_institution` is now the one institution switch (no
`user.show.institution`). Phase 5 (topic pages) is built: anyone verified makes a topic (`/new/topic`,
`POST /api/v1/topics`, names and aliases checked for duplicates first) or makes it from a paper's "Add a topic", which
links the paper (`in-topic`, `introduces-topic`); the page reads as an article with where it started, its broader,
narrower and related topics, venues and organisations, its papers sortable by date, venue and score, and "might
belong here" (`topic_suggestions`, from OpenReview keywords, titles and abstracts; dismissals remembered); editing,
renaming (`page_redirects`) and merging (`pages.merged_into`) are open to the community at `/t/<slug>/edit`.

## Main risks

| Risk                                             | Mitigation                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty pages: nobody writes the first edit        | Launch in one community; seed from citations; notify authors about links; prioritize author sections, because authors have a reason to care |
| Vandalism or disputes between researchers        | Patrol tools in M3, labels requiring notes, no misconduct labels, takedown process                                                          |
| Fear of retaliation limits criticism             | Optional real names and anonymous-but-verified commenting (design section 5.3)                                                              |
| A pseudonymous handle gets linked to a real name | Separate author identities, tested as an invariant; the limits are stated in design section 5.3                                             |
| Sandbox escape or abuse via extensions           | Separate domain, CSP, per-user install, kill switch, reviewed defaults                                                                      |
| Bad claim impersonates an author                 | Name matching is never automatic; co-author notification and dispute                                                                        |
| Git-format bugs                                  | `git fsck` under property tests from the first commit                                                                                       |
