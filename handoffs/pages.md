# Handoff: pages above the paper (venues, topics, organisations, people)

Status: plan, 2026-11-16. Every phase is built: 1 (the page model), 2 (venue pages), 3 (user pages), 4 (organisation
pages) and 5 (topic pages); see the Log. Score standing's org view, which Phase 4 unblocked, is built too
(`handoffs/plugins.md`, Phase 6's org view). What remains is "Later" and the open questions. Read with `handoffs/plugins.md`: plugins work on every kind of
page this plan adds.

## Goal

Today the site has one kind of page, the paper. Researchers also think in venues, research topics, institutions
and labs, and people. Each of these becomes a page of its own, built the same way as a paper's: a git repo of small
files with path rules, derived data from outbox consumers, named slots, and file types that bots write and plugins
show. A plugin written once can then add a panel to a paper, a venue, a topic, an organisation or a person.

## Decisions (made with Benedict, 2026-11-16)

- **One page model for every kind.**
  - Add a `pages(id uuid pk, kind, key, created_at)` table, unique on `(kind, key)`.
  - The git and outbox tables (`page_objects`, `page_refs`, `page_revisions`, `page_current`, `page_events`, and the
    rest keyed by `paper_id`) are re-keyed to `page_id`, referencing `pages`.
  - A paper's page id **is** its paper id, so the migration is a rename plus one `pages` row per existing repo.
  - Everything else holds as it is: one repo per page, one repo per transaction, `GitRepo`, `commitPage`, the
    outbox, and the scaling seams in DESIGN.md §4.11 (now "keyed by `page_id` first").
  - Nothing is live yet, so the rename is a plain migration.
- **Kinds are a registry, like file types.** Each kind declares:
  - its address form;
  - its kind file and that file's schema;
  - its path rules;
  - its slots;
  - which file types it allows.

  Paper is the first kind. A new kind is a registry entry plus its routes, not a fork of the page code.

- **The kinds and their addresses.** Each kind's public identifier is also what a link's `to` holds (DESIGN.md §8),
  so a clone still means something on its own.

| Kind  | Address                                                                       | Identifier         | Kind file                                                                        |
| ----- | ----------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| paper | `/abs/…` as today                                                             | `arxiv:…`, `doi:…` | `.potentialpaper/metadata.json`                                                  |
| venue | `/v/iclr` (series), `/v/iclr/2027` (edition), deeper for tracks and workshops | `venue:iclr/2027`  | `venue.json`: name, dates, URL, `sources` (`openreview:ICLR.cc/2027/Conference`) |
| topic | `/t/<slug>`                                                                   | `topic:<slug>`     | `topic.json`: name, aliases, `broader` topics (optional, a DAG)                  |
| org   | `/o/<slug>`, `/o/<slug>/<child>` for departments and labs                     | `org:<slug>`       | `org.json`: name, `domains`, `parents`, ROR id                                   |
| user  | `/u/<handle>`                                                                 | `user:<handle>`    | `profile.json`: what the person chose to show                                    |

- **Shared layout.** Every kind has the same layout:
  - `.potentialpaper/` for the system;
  - sections in `NN-*.md` files, written like a paper's. They live in up to two folders. One is the owners' section,
    where the kind has owners: `author/` on a paper, `organizers/` on a venue, `members/` on an org, `about/` on a
    user page. The other is `community/`, on every kind except user pages;
  - `links.jsonl` (labeled links from this page, to pages of any kind);
  - the kind file;
  - `extensions/<id>/` for plugins' and bots' data;
  - bot folders granted by path, as `reviews/<source>/**` is today.
- **Who may edit, as path rules per kind** (`rules.ts` gains the kind):
  - Venue: two sections, as a paper has.
    - `community/`: any verified account, from the moment the page exists, subject to page protection.
    - `organizers/`: confirmed organisers only. An organiser claims the venue as an author claims a paper,
      confirmed by an admin for now (`claims:decide`). Until someone claims it, the section stays empty and the
      page shows "Organise this venue? Claim it".
    - The kind file and `sources`: the `venues` bot, organisers and admins.
  - Topic: community-run, like a Wikipedia article. Any verified account can make a topic and edit any topic's
    `community/`, `topic.json` (name, aliases, broader topics) and links, subject to page protection. Changes to
    `broader` show in the patrol feed, since they move papers between roll-ups. No bot writes topic pages.
  - Org: `members/` for verified members (an affiliation whose domain is one of the org's `domains`), `community/`
    for any verified account, and the kind file for members and admins.
  - User: only the account itself, its agents' tokens, and admins.
- **Membership is links and projections.**
  - A paper is at a venue through its submissions: the projection that already exists.
  - A paper is in a topic through a labeled link from the paper to `topic:<slug>`, asserted by the community or by
    an author: `in-topic` ("is about" / "covered by") or `introduces-topic` ("introduces" / "introduced by"), so a
    topic page can list where the idea started apart from the work on it. Machines only suggest
    (`topic_suggestions`, not links): OpenReview keywords, title and abstract matches on a topic's name and aliases,
    and later the map's nearest neighbours of the papers already in it. A suggestion becomes a link when a person
    confirms it.
  - A paper is from an org through confirmed author claims of verified members who chose to show their
    institution, and through the domains printed on page 1 (`pdf_documents.emails`).
  - One consumer keeps `page_members(scope_page_id, paper_id, via, weight)` from all of these. Every list, count,
    statistic and plugin query above the paper reads that table.
- **Topics are concepts, not a taxonomy** (decided 2026-11-16). A topic is a research idea at the size of a
  Wikipedia article ("Linear attention", "State space models", "Mixture of experts"), not a field such as `cs.LG`.
  The page is an article the community writes, plus the papers on it. There is no seeded list: topics exist because
  someone made them. `broader` is optional and loose ("Linear attention" under "Efficient transformers").
  Topic-to-topic links (`related-to`) carry everything else.
- **Hierarchies roll up.** A topic's papers include those of the topics it is broader than. A series' papers are its editions'. An org's
  papers are its children's. The consumer keeps the closure (`page_ancestors`), so a roll-up is one join.
- **Every account has a public page at `/u/<handle>`** (decided 2026-11-16). It is made with the account, so a
  handle always resolves to a page. What it shows is the account's choice, through `profile.json` and the `user.*`
  settings (`handoffs/plugins.md` Phase 1). Exactly which items there are, and their defaults, are decided when
  Phase 3 is built. Until then the safe default holds: the page shows the handle, the `about/` section and
  activity under the handle, and it never connects the handle to an author identity (DESIGN.md §5.3) unless the
  account chooses to. Plugins see exactly what the public sees. This is the one place where adding a kind can leak
  something, so the rule lives in the `user` kind's projection, not in its page component or in plugins.
- **Search** indexes every kind. `kind:venue` and the other kinds become scopes, as `in:reviews` is.

## Phases (one agent each; update this file at the end of yours)

### Phase 1: the page model

- The `pages` table, the `paper_id` → `page_id` migration, and the kind registry (`lib/kinds.ts`, next to
  `server/pages/schemas.ts`'s file types, which gain `kinds`).
- `rules.ts`, `commitPage`, clone and push over HTTP and SSH, the outbox and the consumers become kind-aware. A
  consumer declares the kinds it handles.
- Links: `to` accepts any kind's identifier. `page_links` becomes kind-aware, so "what links here" works on every
  page. Add the `in-topic` label.
- `page_members` and `page_ancestors` with their consumer, starting with venue membership from `submissions`.
- Routes and slots per kind, generic: `<kind>.main`, `<kind>.aside`, `<kind>.tabs`. The paper page's slots
  (`components/paper/slots.tsx`) become the first instance.
- Checks: every existing test passes against the renamed tables, and clone and push still work.

### Phase 2: venue pages

- A `venues` bot, granted the kind files of venue pages, makes series and edition pages from the venues the
  OpenReview import already knows (`venues` rows map to `sources`).
- `/v/<series>`: editions over time. `/v/<series>/<edition>`: about, dates, papers (by status, with filters), and
  the score statistics (`handoffs/plugins.md`, Phase 4) once they exist.
- `community/` is open from the start. `organizers/` comes with organiser claims, built on the author claim flow
  (`server/claims.ts`), with a venue as the claimed page.

### Phase 3: user pages

- Every account gets `/u/<handle>`, made at sign-up and backfilled for existing accounts. The profile page links to
  it. `profile.json` holds what the account chose to show.
- `about/` is free text; `links.jsonl` holds links to homepage, ORCID, Scholar and to their own work.
- Decide the items and defaults with Benedict before building them: real name, institution, claimed papers,
  activity, comments. Each is a `user.show.*` setting that defaults to the §5.3-safe value.
- Activity on the page (edits, links, comments under the handle) comes from the outbox. Bot commits are hidden, as
  in the feed.

### Phase 4: organisation pages

- An `orgs` bot seeds pages from `config/institution-domains.json` and `institution_domains`, with ROR ids where we
  have them. Departments and labs are child pages that verified members make.
- Shows members who chose to show their institution, the org's papers (rolled up from its children), and venues and
  topics by count.

### Phase 5: topic pages

- No seeding. Anyone verified can make a topic: a "New topic" form, or "Add a topic" on a paper's page, which links
  the paper and makes the topic if no topic of that name or alias exists yet. The form checks names and aliases
  first, to keep duplicates down.
- The page reads as an article: the community's sections first (what it is, key ideas, history, open problems), then
  the papers that introduced it, the papers on it (rolled up from narrower topics, sortable by date, venue and
  score), narrower, broader and related topics, the venues where it is common, and the orgs active in it.
- "Might belong here": `topic_suggestions` for the topic, each with confirm and dismiss. A dismissal is remembered,
  so the suggestion doesn't come back.
- Editing a topic (name, aliases, broader topics, sections, links), merging and renaming is open to the community,
  with page protection and the patrol feed. A merge or rename leaves a redirect, as paper merges do.

### Later (not this plan)

- Embedding clusters as suggested new topics, from the map's vectors.
- Workshops and tracks as venue children with their own sources.
- Following a page of any kind for the feed and notifications.

## Open questions

- Which items a user page can show, and their defaults (Phase 3). **Built without Benedict, to confirm:** real name,
  institution and authored papers off; activity and comments under the handle on (see Phase 3's Log). Phase 4 folded
  the institution into one switch, `accounts.show_institution` (see its Log); `real_name` still shows beside the handle
  on comments whenever it is set, while `user.show.realName` governs the page only. Folding that too is still open.
- A small org can still give away who wrote what (Phase 4): if the only person an org lists is @ada and a paper is on
  its page with no address at its domains on page 1, @ada is probably an author. Nothing public says why a paper is
  there, but the inference stays possible. Requiring `user.show.claimedPapers` as well for claim-based membership
  would close it, at the cost of fewer papers on org pages.

## Log

**How the phases run:** one T3 thread per phase, on its own branch (`pages-phase-<n>`), cut from the previous phase's
branch so this file stays current. Commit and push after each working step. At the end, add your entry below and
launch the next phase's thread pointing at this file. Merging into `main` waits for Benedict.
Phase 1 comes before `handoffs/plugins.md` Phase 2, so the plugin host is built for every kind from the start.

### Phase 1: the page model (2026-11-16, branch `pages-phase-1`)

Built:

- **`pages(id, kind, key)`** (`drizzle/0032_pages.sql`), unique on `(kind, key)`. A paper's page id is its paper id
  and its key is that id; its row is made and deleted with the paper by triggers (`papers_page_insert`,
  `papers_page_delete`), so every writer of `papers` (imports, merges, on-demand creation) gets one, and the
  migration made one per existing paper (not only per repo). `page_objects`, `page_refs`, `page_revisions`,
  `page_current`, `page_events`, `search_docs` and `demo_pins` are renamed `paper_id` → `page_id` in place and
  reference `pages`. `bot_grants` gains `kind` (default `paper`; key `(account, kind, pattern)`).
- **The kind registry, `src/lib/kinds.ts`**: per kind its route, identifier form (`venue:iclr/2027`), kind file
  and zod schema (`venue.json`: name, dates, url, sources; `topic.json`: name, aliases, broader; `org.json`: name,
  domains, parents, ror; `profile.json`), parts (owners' and `community/`), slots, file types, plugin context
  keys, whether it is a scope, and key depth. Also `parseIdentifier`/`formatIdentifier`, `pagePath`,
  `parentsOf`, `sourcesOf`. `server/pages/schemas.ts` gained `labeledLink` (JSONL), `venue`, `topic`, `org` and
  `profile` file types, sections in every kind's parts, and `kindsOfFileType`.
- **Kind-aware writes**: `rules.ts` (`layoutProblem`, `pathDenied`, `contentProblem`, `grantProblem` take the
  kind), `check.ts` (`rolesOf` reads the page's kind; `Roles.confirmedAuthor` is now `owner`), `commit.ts` (the
  first commit's metadata per kind; `createPage(kind, key)` makes a page and starts its repo with the system's
  commit), `projections.ts` (the owners' part into the `author_*` columns; `page_current.kind_file` and `.name`).
  `npm run pages:create -- <kind> <key>` for admins.
- **Clone and push** at `/git/<kind>/<key>.git` over HTTP, and over SSH at `<route>/<key>` or `<kind>/<key>`
  (`clone.ts`'s `GitAddress.page`, `findRepo`, `pageClonePath`; `ssh-command.ts`). Pushes refresh the page's
  address (`refreshPages`). Tested with stock git on a venue page (`tests/integration/kinds.test.ts`).
- **Consumers declare kinds** (`Consumer.kinds`; `reviews` is paper-only). Two new consumers:
  - `links` (`server/page-links.ts`): every part's `links.jsonl` into `page_links`; `linksFrom`/`linksTo` ("what
    links here", by resolved page or any identifier the page answers to, so a target named before its page existed
    is found). It refreshes the pages its links name.
  - `members` (`server/page-members.ts`): `page_member_sources` (what each paper says it belongs to: submissions
    as `<source>:<venue id>`, `in-topic`/`introduces-topic` links), `page_scope_names` (a scope's identifier and
    `venue.json` `sources`), `page_parents`, and from those `page_members` and the closure `page_ancestors`.
    `scopeMembers`, `scopeMemberCount`, `scopePapers` roll up by default.
- **Labeled links** (`src/lib/labeled-links.ts`): DESIGN.md §8's vocabulary plus `in-topic` and
  `introduces-topic`, each label with the kinds it may go from and to; checked per line at commit.
- **Routes and slots per kind**: `/v/[...key]`, `/t/[slug]`, `/o/[...key]`, `/u/[handle]`
  (`components/pages/page-route.tsx`, `slots.tsx`), each from `<kind>.main`, `<kind>.aside`, `<kind>.tabs`
  (`ArrangedTabs`). Every kind's panels are in `lib/panels.ts`, so their `<kind>.panels.*` settings appear on
  their own. The paper page gained `paper.tabs` and the `links` and `backlinks` panels.
- DESIGN.md §4.1, §4.3, §4.5, §4.9–4.11 (now "keyed by `page_id` first") and §8 updated; IMPLEMENTATION.md notes it.

Calls I made where the plan left room:

- **`page_links` didn't exist** (labeled links, Milestone 4, weren't built), so this phase built the minimum:
  the file type, the label table, the index and "what links here". No "add a link" form, stances or graph.
- **`links.jsonl` lives in each part** (`community/links.jsonl`, `author/links.jsonl`, `about/links.jsonl`), not at
  the top, because DESIGN.md §8 takes `origin` from the path and the path rules then need nothing new.
- **`page_links` and membership are consumers**, not written in the commit's transaction (DESIGN.md §4.4 said
  `page_links` was): `handoffs/data-model.md` decided only `page_current` is. They catch up in seconds.
- **Membership is joined from both halves** (`page_member_sources` × `page_scope_names`) so it's the same whatever
  page changes first and rebuilds identically. `page_ancestors` is recomputed whole on each scope's event (scopes are
  few; cycles stop at depth 16 or when they return).
- **Which tables were re-keyed**: those of the repo (objects, refs, revisions, current, events, search docs, demo
  pins). Tables about papers as papers (`author_claims`, `submissions`, `comments`, `paper_follows`, agent posts) keep
  `paper_id`. Comments and follows on other kinds come with their phases (follows are in "Later").
- **Other kinds start with a system commit** (metadata, `.gitattributes`, `prek.toml`; no starter sections), so they
  can be cloned and pushed at once; a paper still starts at its first edit.
- **`related`**, DESIGN.md's existing label, is the topic-to-topic `related-to` of the plan.
- **Owners outside papers**: a user page's owner is the account whose handle is the key; venue organisers and org
  members are not owners yet (Phases 2 and 4), so only admins (and a venue/org bot granted the kind file) write
  those parts. Grants: venues and orgs may grant their kind file; no bot writes topic or user pages.
- **`profile.json` is `{}` only** until Phase 3 decides its items; a user page's name is always `@handle`.
- **Search**: `search_docs` now indexes every kind's files, but `server/search.ts` still returns papers only;
  `kind:` scopes come later.
- **Pages of other kinds revalidate every 5 minutes** (papers: a day), since their backlinks and papers change with
  other pages' commits; link targets are also refreshed by the `links` consumer.

For later phases:

- Phase 2: the `venues` bot needs `npm run bots:grant -- venues venue.json --kind venue --by <admin>`, then
  `createPage('venue', …)` and a commit of `venue.json` with `sources`; membership follows. Organiser claims make
  `owner` true in `check.ts`'s `keyedRoles`.
- Phase 3: user pages are keyed by handle; a handle change has to move the key (and `user:` links).
- The web editor, workspace API and history/diff pages are still paper-only; other kinds are edited by push.
- No `GET /api/v1/pages/{identifier}` yet; plugins Phase 2 (`page.resolve`, `page.read`) is the place for it.
- `prek.toml` changed (more JSON types, prettier on every kind's parts), so existing clones' copy is stale; a commit
  that doesn't touch it is unaffected, and `npm run pages:add-starter` can rewrite it.

Checks: typecheck, lint and `next build` pass. Unit tests: 347 pass (8 new in `tests/unit/kinds.test.ts`).
Integration: 258 of 265 pass, 11 new (`kinds.test.ts`, `page-members.test.ts`); the 7 failures are the same as
before this phase (six `pdf-ingest.test.ts` without poppler, one `follows.test.ts`). Run against this worktree's
own database, `potentialpaper_test_pages1`. One fast-check merge property test (`page-git.test.ts`) failed once
and passed on rerun; it touches nothing changed here.

### Phase 2: venue pages (2026-11-16, branch `pages-phase-2`)

Built:

- **The `venues` bot** (`server/venue-pages.ts`'s `syncVenuePages`, `npm run venues:sync`, and run for its venue at
  the end of `papers:import-reviews`). Migration `0035_venue_pages.sql` makes its account and grants it `venue.json`
  on venue pages, as `0027` did for `openreview`. For every `venues` row that is a conference's main edition
  (`lib/venues.ts`'s `venuePlace`: `openreview:ICLR.cc/2027/Conference` → series `iclr` "ICLR", edition `iclr/2027`
  "ICLR 2027"), it makes both pages (`createPage`) and commits a `venue.json`: `{ name }` on the series,
  `{ name, sources: [<venue id>] }` on the edition, whose source makes the venue's submissions its members. It is
  idempotent, and on a page whose `venue.json` is there it only adds a missing source (`venueFileUpdate`).
- **A series' page** (`/v/iclr`): an `editions` panel, the table of its editions newest first, each with dates,
  submissions and accepted (with the rate). Its Papers tab rolls up its editions' submissions, each marked with its
  edition.
- **An edition's page** (`/v/iclr/2027`): `about` (dates, its own site, "Submissions from OpenReview" linking each
  source), `editions` (its count line, "1,234 accepted of 4,567 (27%)", and the series' years to move between),
  organisers, community, and the Papers tab: its submissions by status (accepted first, then by number), with
  filters by status (with counts), decision as the venue words it, and words in the title, and "Show more".
  The first page is rendered on the server (the page stays one cached HTML for every reader); filters and paging
  fetch `GET /api/v1/pages/{identifier}/venue-papers?status=&decision=&q=&offset=&limit=` (public, a minute's cache),
  which `server/venue-pages.ts`'s `venuePapers`/`presentVenuePapers` answer for any venue, rolled up.
- **Organiser claims** (`server/page-claims.ts`, table `page_claims(page_id, account_id, evidence, status,
decided_by, decided_at)`), the author claim flow with the venue as what is claimed: `/claim/venue/<key>` (the
  page's "Organise this venue? Claim it" leads there) and `GET`/`POST`/`DELETE /api/v1/pages/{identifier}/claim`.
  An admin decides with `npm run claims:decide`, which now lists and decides both kinds of claim. A confirmed
  organiser is an owner in `check.ts`'s `rolesOf` (so `viewer.isOwner` for plugins too), and writes `organizers/`
  and `venue.json`.
- **Score statistics' place:** `venueScoreStats(pageId)` in `server/venue-pages.ts` returns `null`, and the
  `VenuePapers` panel (`components/pages/venue-panels.tsx`) renders whatever it returns above the list.
- DESIGN.md §4.3 (venue pages), §6 (claims on other pages) and §10 (the `venues` bot), IMPLEMENTATION.md ("Pages
  above the paper") and `llms.txt` (the two routes) updated.

Calls I made where the plan left room:

- **Only a conference's main edition maps to a page.** Tracks (`NeurIPS.cc/2025/Datasets_and_Benchmarks_Track`),
  workshops and undated venues (`TMLR`) are skipped and reported, waiting for "Workshops and tracks as venue children
  with their own sources" (Later). The series is named from the segment before the year without its domain
  (`ICLR.cc` → ICLR, `robot-learning.org/CoRL` → CoRL); the edition by the venue's own name.
- **The bot is a script, not a consumer.** Consumers rebuild derived rows and shouldn't commit to repos; the import
  already knows its venue, so it calls the bot at its end, and `venues:sync` covers everything else.
- **The bot writes no `url` and no `dates`.** `venues.url` is OpenReview's group page, not the venue's own site, so
  the source link is derived from `sources` instead; OpenReview gives no dates. Organisers and admins add both.
- **A series' organisers own its editions** (by key prefix, `keysAbove`, not `page_ancestors`, so it holds the moment
  a claim is decided). Organisers' commits carry their own `u_` identity, as organising is a public role; still,
  the page doesn't list who the organisers are, only what they wrote.
- **Claims are admin-decided only**: nothing on a venue says who organised it, so there is no automatic route.
  Stepping down or withdrawing deletes the row; a rejection stays, so the same claim isn't made again. Only venues
  are claimable (`CLAIMABLE_KINDS`); an org's members (Phase 4) come from affiliations.
- **"Papers by status" lists submissions**, a paper at a venue: on a series a paper submitted to two editions shows
  under each. A submission whose source gave no status is "Status unknown".
- **The organisers write by `git push`.** The web editor is still paper-only (Phase 1's note), so the claim page
  says to clone the page; a web editor for keyed pages is still to come.
- **`editions` is a new panel id** in `lib/panels.ts` (`venue.main`), so readers can hide or move it.
  `KindPanelProps.key` became `pageKey`, since React keeps `key` to itself and the panels never received it.
- `/claim/venue/<key>` is a static segment beside `/claim/[scheme]/…`; `venue` is no paper scheme.

For later phases:

- Plugins Phase 4 (`scope_stats`): fill `venueScoreStats`, add a `scores` panel to the venue slots in
  `lib/panels.ts`, and `page.hasScores` on a scope can then use the statistics.
- Workshops and tracks: extend `venuePlace` to map them to deeper keys (`iclr/2027/<workshop>`, venue `maxDepth` is
  4); organisers of the edition then own them already.
- Phase 3/4: `page_claims` is per page and kind-agnostic; another claimable kind is a `CLAIMABLE_KINDS` entry plus
  its rule in `rolesOf`.
- The edition list on a series counts each edition's statuses with one query each; fine for tens of editions.

Checks: typecheck, lint and `next build` pass. Unit tests: 372 pass (5 new in `tests/unit/venues.test.ts`).
Integration: 271 of 278 pass, 6 new in `tests/integration/venue-pages.test.ts` (the bot and its idempotence, never
overwriting, its grant; submissions by status, filters, roll-up and the route; organiser claims through the API,
inherited from the series, stepping down, rejection). The 7 failures are the same as before this phase (six
`pdf-ingest.test.ts` without poppler, one `follows.test.ts`). Run against this worktree's own database,
`potentialpaper_test_pages2`, through an untracked `.env`. A smoke run of `next start` against seeded venues served
`/v/iclr` (the editions table) and `/v/iclr/2027` (the source line, the claim link, the empty list), redirected a
signed-out `/claim/venue/iclr` to sign-in, and answered the `venue-papers` route.

### Phase 3: user pages (2026-11-17, branch `pages-phase-3`)

Built:

- **A page with every account** (migration `0037_user_pages.sql`): triggers on `accounts` make the `pages` row
  (`user`, handle) on insert, move its key on a handle change, and delete it with the account; the migration made one
  for every existing account. A changed handle leaves `page_redirects(kind, key, page_id)`: `/u/<old>` redirects (307)
  and `user:<old>` resolves (`findPageByAddress` → `redirectedPage`) until another account takes the old handle,
  whose trigger deletes the redirect. `afterHandleChange` (from `updateProfile`) commits the page's metadata with its
  new key and refreshes both addresses.
- **The repo starts at sign-up** (`ensureAccountForUser` → `startUserPage`): the system's first commit, with
  `profile.json`. `npm run users:pages` does the same for existing accounts (idempotent).
- **What it shows: `user.show.*` settings** (`lib/user-pages.ts`, `lib/settings/core.ts`), each a boolean with a
  `switch` widget in a "Your public page" group of `/settings` (signed in only):

  | Setting                   | Default | Shows                                                                                  |
  | ------------------------- | ------- | -------------------------------------------------------------------------------------- |
  | `user.show.realName`      | off     | `accounts.real_name`, under the handle                                                 |
  | `user.show.institution`   | off     | `accounts.institutions` (confirmed addresses')                                         |
  | `user.show.claimedPapers` | off     | papers with a confirmed author claim, each with the name printed on it                 |
  | `user.show.activity`      | on      | commits under the account's `u_` identity, every kind, newest first (outbox order), 50 |
  | `user.show.comments`      | on      | signed comments, not removed, not on a paper it is a confirmed author of, newest first |

  They are **`accountOnly`** (a new `CoreSetting` flag): resolved from the user layer only, and a site file naming
  one gets a warning, so no admin can publish everyone's names by changing a default.

- **The rule in one place, `server/user-pages.ts`'s `userPageView`**: the page's panels, plugins' `page.read` (and
  `GET /pages/{identifier}/files`, through `userKindFile`: `show`, and `realName`, `institutions`, `papers` only when
  shown) all read it. Never listed, whatever the settings: `a_` (author-identity) commits, anonymous comments,
  comments on the account's own papers, and a bot's activity.
- **`profile.json`** is `{ "show": { "<item>": bool, … } }`: the choices, never the values. Only the system writes it
  (`rules.ts`; the account's push is refused with "follows your user.show.* settings"), from `saveUserSettings`
  whenever an item changes (`syncProfileFile`), which also refreshes `/u/<handle>`.
- **The page** (`components/pages/user-panels.tsx`, `lib/panels.ts`): `user.main` has `identity` (real name and
  institutions under the handle), `about`, `papers`; `user.aside` links and backlinks; `user.tabs` `activity` and
  `comments`. A tab whose item is off isn't there at all (`PRESENT` in `slots.tsx`). `/profile` says where the page
  is and links to the settings.
- **Person links** (`lib/labeled-links.ts`): `homepage`, `orcid` (orcid.org) and `scholar` (scholar.google.com) go
  from a user page to an https address (`targetKind: 'web'`, a new value of `page_links.target_kind`; no "what links
  here" for them); `wrote` goes from a user page to a paper. The links box shows a web link by its address with
  `rel="me"`.
- DESIGN.md §4.3 (user pages), §5.3 (the items and defaults), §8 (the labels) and §10; IMPLEMENTATION.md; `llms.txt`.

Calls I made where the plan left room:

- **The items and defaults (for Benedict to confirm, in Open questions).** Off: real name, institution, authored
  papers, each of which can tie the handle to a person or to the names on papers. On: activity and comments, which are
  public under the handle on each page already, so listing them links nothing new. The plan's "safe default" names
  "activity under the handle" as shown, which I took to cover comments under the handle too.
- **Settings are what count; `profile.json` mirrors them.** The plan says both "a `user.show.*` setting" and
  "`profile.json` holds what the account chose". Two writable copies would disagree, so the settings are the source
  and only the site writes the file. The file holds no values: a real name committed once stays in a public history
  after it is turned off. The page reads the settings, so a failed sync never shows more than chosen.
- **The bylines elsewhere are unchanged.** `real_name` (shown beside the handle on comments when set) and
  `show_institution` still govern comments and My papers; `user.show.realName`/`institution` govern the page only.
  Folding them together is a decision for Benedict (Open questions).
- **Rows by trigger, repos by code.** A trigger covers every writer of `accounts` and the rename's atomicity; a
  commit can't be made in SQL, so the repo starts at sign-up and by script. A page with no repo still renders
  (name `@handle`, defaults).
- **Activity reads `page_revisions` joined to `page_events`** (the outbox row of the same commit) rather than a new
  consumer: both are written in the commit's transaction, ordered by event id. Bot commits are hidden by being a bot's
  page; the account's own commits are never a bot's.
- **A handle change is in the page's history** (the metadata commit "Handle is now @…"); the redirect says the same
  publicly anyway. The old handle can be taken at once, as before.
- **`wrote` shows on the paper's "what links here" as "written by @handle".** That ties the handle to the paper by
  the person's own act, in their own `about/links.jsonl`; nothing else does.
- **The page is cached 5 minutes** (as Phase 1 left keyed pages); settings changes, profile edits and handle changes
  refresh it at once, new activity elsewhere shows within the 5 minutes.

For later phases:

- Phase 4 (orgs): members who "chose to show their institution" can read `shownFor(account).institution` (or
  `show_institution`, until Open questions settles which).
- Phase 5 (topics) and following pages: a topic's "orgs active in it" and any people list must go through
  `userPageView`'s rules, not `accounts` directly.
- The web editor is still paper-only, so a person writes `about/` by `git push` (`/git/user/<handle>.git`).

Checks: typecheck, lint and `next build` pass. Unit tests: 394 pass (8 new in `tests/unit/user-pages.test.ts`:
defaults, account-only resolution, strict values, the form widget and JSON Schema, `profile.json`, excerpts, person
links; `kinds.test.ts` updated for `profile.json`). Integration: 284 of 291 pass, 5 new in
`tests/integration/user-pages.test.ts` (made at sign-up and moved with the handle, redirects and an old handle
retaken, deletion; the §5.3 defaults on the view, `page.read` and the files route; opting in and out with
`profile.json` following and no name in any commit; the account refused `profile.json`; the site layer ignored;
activity and comments with author-identity edits, anonymous comments and own-paper comments left out; person links
and "what links here"). The 7 failures are the same as before this phase (six `pdf-ingest.test.ts` without poppler,
one `follows.test.ts`); `comments.test.ts` failed once on a random UUID containing "ada" and passed on rerun. Run
against this worktree's own database, `potentialpaper_test_pages3`, through an untracked `.env`. A smoke run of
`next start` served `/u/<handle>` (no real name in the HTML with the defaults, Activity and Comments tabs) and
redirected the old handle with a 307.

### Phase 4: organisation pages (2026-11-17, branch `pages-phase-4`)

Built:

- **The `orgs` bot** (`server/org-pages.ts`, `npm run orgs:sync [-- --domain <d>… | --all]`). Migration
  `0038_org_pages.sql` creates its account and grants it `org.json` on org pages.
  - **What an institution is:** a name on the sign-up allowlist (`config/institution-domains.json` with the
    `institution_domains` table over it), with every domain the list gives that name (shortest first, at most 20).
    Its ROR id comes from the new `config/institution-ror.json`, which `npm run institutions:build` now writes. The
    flag `--ror-only` writes just that file for the list as it is; it holds 36,119 domains, each matched only where
    ROR's name agrees with the list's.
  - **Which institutions get a page:** by default, the ones in use. That means a confirmed address, an address printed
    on a paper's page 1, or a domain an admin added. `ensureOrgPageFor` also makes a page at sign-up and when an
    address is confirmed, and `pdfs:ingest` syncs after each pass that read PDFs.
  - **Its key** is the name as a slug when it is short and Latin (`eth-zurich`). Otherwise it is the label of the
    institution's shortest domain (`mit`), then the whole domain (`ucl-ac-uk`). A key another page already holds is
    skipped. An institution's page is the top-level org page whose `org.json` lists one of its domains, so a page
    keeps its key whatever the list later calls it.
  - **What it writes:** like `venues`, it never removes anything or overwrites a name. On a page whose `org.json` is
    there, it only adds missing domains and a missing ROR id (`orgFileUpdate`).
  - **Without its grant** the script refuses with the `bots:grant` command to run, and the sign-up hook does nothing.
- **Membership** (`server/page-members.ts`), what `scope_stats` and the score-standing org view need:
  - **How a paper gets on an org:** through a confirmed author claim by a verified, non-bot account that shows its
    institution, from each confirmed address (weight 1). Also through each address printed on page 1 of the paper's
    current PDF (`pdf_documents.emails`, weight 0.5).
  - **How the names match:** each such address gives a source `domain:<d>` for every domain from the address's own up
    to its last two labels (the SQL function `domain_suffixes`). An org answers to `domain:<d>` for each `org.json`
    domain (`sourcesOf`). Both kinds of source share one `via`, `affiliation`, which is the only thing
    `page_members.via` and the public routes show.
  - **Keeping it current:** these come from tables, not from repos. Triggers on `author_claims`, `affiliations`,
    `accounts` (`show_institution`, verified, bot) and `pdf_documents.emails` queue the papers affected
    (`org_members_due`). The worker's new `org-members` task (`syncDueAffiliations`, run before `scope-stats`) brings
    those papers up to date in batches, marking their scopes before and after.
  - **On the paper's own events and on rebuild:** a paper's event rewrites its affiliation sources too. The consumer's
    `reset` writes every paper's affiliation sources, so a rebuild also covers papers that have a claim but no repo.
    `page_member_sources` gained `weight`, and the joins carry it into `page_members.weight`.
  - **Roll-up:** papers roll up from departments through `page_ancestors`, already built (an `org:a/b` page's parent
    is `org:a`).
- **Members and rules** (`server/org-roles.ts`, `check.ts`):
  - **Who is a member:** an account with a confirmed address at one of the org's domains, or under one. This counts on
    the page and on every org above it by key, read from `page_current`, so a new domain counts at once.
  - **What members may do:** members are the owners. They write `members/` and `org.json`, whether or not they show
    their institution, since writing there is their own act.
  - **Domains:** `checkOrgDomains` refuses widening or removing a top-level org's domains (including deleting its
    `org.json`) to anyone but admins and the bot. A department's domains must be its organisation's or under them.
- **Departments and labs:** members (and admins) make them at `/new/org/<key>` (a form) or with
  `POST /api/v1/pages/{identifier}/children` `{ slug, name, domains? }`. `createOrgChild` checks the domains before it
  makes the page, commits `org.json` as the member, and removes the page if that commit is refused.
- **The page** (`components/pages/org-panels.tsx`, `lib/panels.ts`):
  - `org.main`: `about` (the org above it, domains, ROR), `departments` (each with its rolled-up paper count, and the
    "Add a department or lab" link), members, community.
  - `org.aside`: `people` (handles of members who show it as their institution), `venues` and `topics` (pages its
    papers are directly in, by paper count, from `scopeOverlap`), links, backlinks.
  - `org.tabs`: papers, rolled up.
  - Everything is read once by the route (`orgOverview`). `GET /api/v1/pages/{identifier}/org` gives the same
    (public, a minute's cache, in `/openapi.json`).
- **The institution switch, unified:** `accounts.show_institution` is now the one switch, and
  `user.show.institution` is gone from the settings (a file naming it gets an unknown-key warning).
  - What it governs: comments, the person's page, the org's people list and claim-based membership.
  - `profile.json` still says `show.institution`, now mirrored from the column. `updateProfile` syncs it when the
    column changes.
  - The profile form, `/profile` and the settings descriptions say what showing it does.
- Docs: DESIGN.md §4.3 (organisation pages), §4.9 (data from tables: the queue and task), §5.3 (one institution
  switch) and §10 (the `orgs` bot); IMPLEMENTATION.md; `llms.txt` and an `/agent/updates` notice.

Calls I made where the plan left room:

- **`show_institution`, not `user.show.institution`.**
  - _Why the column wins:_ both settings meant "my institution is public", and the column already put it beside the
    handle on every comment. A second setting that hid it only on the page could only disagree with the first.
  - _Why not a setting:_ the column is what SQL can join for membership and people lists over many accounts, and it
    is what onboarding asks explicitly. A settings document would have to be parsed per account.
  - _Effect:_ the page's institution item now follows the profile.
- **Not every institution gets a page by default.** The list has about 55k names (schools, ministries). Making every
  page is opt-in (`--all`); the default covers what is in use, and new members' institutions appear on their own.
- **An institution is a name on the list.** Two institutions with the same name in different countries (a "Ministry
  of Education") share a page. ROR ids can't separate them, as the list has none of its own.
- **Members needn't show their institution to write.** They must show it to be listed or to bring their papers.
- **Printed addresses count at weight 0.5** (the schema's "counts for less than certain"). Nothing reads weights yet.
- **Org children are at most 3 levels deep** (`maxDepth`). A department with no domains of its own gets papers only
  from labs under it.
- **The "Add a department or lab" link shows to everyone,** since the page is one cached HTML for all readers. The form
  page checks membership.
- **Org page people show handles only,** whatever `user.show.realName` says. Those rules live in `server/user-pages.ts`
  (`orgPeople`), as Phase 3 asked of any people list.

For later phases:

- **Score standing's org view:** `page.hasScores` is now true on an org with scored papers, and `scope.scores(org)`
  lists its venues. What plugins Phase 6's Log said the view still needs (a way from a venue id to its venue page, and
  named marks) is unchanged.
- **Phase 5 (topics):** `scopeOverlap(scopeId, 'venue' | 'org')` gives "venues where it is common" and "orgs active in
  it" directly.
- **A person's page** could link each shown institution to its org page; not done.
- **The web editor is still paper-only:** members write `members/` by `git push` (`/git/org/<key>.git`).

Checks: typecheck, lint and `next build` pass. Unit tests: 395 pass. `user-pages.test.ts` has a new case: the
institution is not a setting.

Integration: 290 of 297 pass, 1 skipped (the network plugin test). The 7 failures are the same as before this phase:
six in `pdf-ingest.test.ts` (no poppler) and one in `follows.test.ts`.

- 6 of them are new, in `tests/integration/org-pages.test.ts`:
  - the bot: domains, ROR, idempotence, never renaming, key fallback, "in use", the sign-up hook, and the missing
    grant;
  - claim membership following `show_institution` both ways through the queue;
  - printed subdomain addresses at weight 0.5;
  - `via` `affiliation` in the public members route;
  - departments by API (domains under the parent, non-members refused), roll-up, and a rebuild giving identical rows
    with a repo-less claimed paper;
  - members writing `members/` and `org.json` but not top-level domains, admins may;
  - people listed only when shown, the `/org` route, and `profile.json` following the profile.
- `user-pages.test.ts` was updated for the single switch.
- The test fixture allowlist gained `mit.edu`, and a ROR fixture was added (`INSTITUTION_ROR_PATH`).

These ran against this worktree's own database, `potentialpaper_test_pages4`, through an untracked `.env`.

### Phase 5: topic pages (2026-11-17, branch `pages-phase-5`)

Built:

- **Making a topic** (`server/topic-pages.ts`, `lib/topics.ts`):
  - `/new/topic` (a form: name, address, other names, broader topics, "What it is") and `POST /api/v1/topics`.
    Anyone verified may. The topic's `topic.json` (and the article's first section, `community/10-what-it-is.md`)
    is committed by whoever makes it, so the path rules check it as any edit.
  - **Names are checked first.** Two names are the same when they differ only in case, accents, punctuation and
    plurals (`topicNameKey`: "State-space models" = "state space model"). A name or alias another topic has is
    refused with `409 topic_exists`, naming that topic. `GET /api/v1/topics?q=` lists the same name first (`exact`),
    then similar ones (pg_trgm); the forms show it as one types and the new-topic form won't submit a duplicate.
  - `broader` must name topics that exist; they are written by their current slug.
- **A paper in a topic:** a Topics box on every paper (`paper.aside`, panel `topics`) lists its topics and has "Add a
  topic": a name, offered from existing topics as one types, and "is about it" or "introduced it".
  `POST /api/v1/pages/{paper}/topics` `{ topic | name, label? }` appends the link to the paper's
  `community/links.jsonl`, or `author/links.jsonl` when one of its confirmed authors adds it, and makes the topic if
  it was named and no topic has the name or an alias. Link ids are ULIDs (`newLinkId`). The paper's Links box no longer
  repeats topic links.
- **The page** (`components/pages/topic-panels.tsx`, `lib/panels.ts`), read once by the route (`topicOverview`,
  `presentTopicPapers`):
  - `topic.main`: `about` (other names, merged topics, "Edit this topic", "New topic", the protection), `community`
    (the article), `introduced` (where it started: the papers that introduced it, oldest first).
  - `topic.aside`: `topics` (broader, narrower and related, each with its rolled-up paper count), `venues` and `orgs`
    (`scopeOverlap`, by count), links, backlinks.
  - `topic.tabs`: `papers` (rolled up from narrower topics, each with the narrower topic it is in, "introduced it",
    its venue and decision, and its score; sortable by date, venue and score, `GET …/topic-papers?sort=`) and
    `suggestions` ("Might belong here").
  - `GET /api/v1/pages/{identifier}/topic` gives the overview.
- **Might belong here** (`server/topic-suggestions.ts`, table `topic_suggestions`, the `topic-suggestions` consumer for
  papers and topics):
  - OpenReview **keywords** are now kept: `submission.json` has an optional `keywords`, the reviews import writes it
    from scrapes that have the column, and the projection fills `submissions.keywords`. A keyword with the same words
    as a name (English stems, any order) scores 3; the name as a phrase in the title 2, in the abstract 1 (names of two
    words or more only). A paper's score is the sum, its reason the strongest. Papers already in the topic aren't
    suggested; each topic keeps its best 200.
  - Confirm links the paper (`in-topic`, or "It introduced this"); dismiss is remembered. Only `open` rows are ever
    rewritten, so neither comes back, through a recompute or `consumers:rebuild -- topic-suggestions`.
    `GET`/`POST /api/v1/pages/{identifier}/suggestions`.
- **Editing, renaming, merging** (`/t/<slug>/edit`):
  - One form for name, aliases, broader and related topics (`related` links in `community/links.jsonl`, other lines
    kept) and the whole article as Markdown with a `#` heading per section (`planSections`; an empty article starts
    from "What it is / Key ideas / History / Open problems", and a heading with nothing under it isn't saved).
    `PATCH /api/v1/pages/{identifier}/topic` `{ base, … }`, one commit merged with what changed since `base`.
  - **Rename** (`POST …/rename` `{ slug, name? }`): the page's key moves in one transaction, the old slug goes into
    `page_redirects`, and the system commits the metadata ("Moved from topic:a to topic:b by @handle"). A new name
    is the person's own commit, keeping the old name as an alias.
  - **Merge** (`POST …/merge` `{ into }`): the survivor gains the duplicate's name and aliases as aliases, its
    broader topics, its sections (each "From topic:x, merged into this page.", text it already has skipped) and its
    links, in one commit by the person. The duplicate gets `pages.merged_into`, takes no more commits
    (`409 page_merged`), and its redirects and anything merged into it move along. Decided suggestions move too.
  - **Old names keep counting.** `findPageByAddress` follows redirects and merges (`survivorOf`); `/t/<old>` redirects.
    `formerKeys` (old slugs, merged topics' keys) are among the page's `page_scope_names`, so papers and narrower
    topics that name the old identifier stay in, and among what "what links here" matches. A new page that takes an
    old key takes its address (a trigger on `pages`).
- **Page protection** (DESIGN.md §7, `server/page-protection.ts`, table `page_protection`): `established` (accounts
  verified at least 4 days ago) or `admins`, optionally until a date. Set by admins with `npm run pages:protect` or
  `PUT /api/v1/pages/{identifier}/protection`; `GET` is public, and the page and editor say it. It is checked in
  `checkTree`, so a push is held like a web edit. It holds what the community writes on any kind of page; owners keep
  their own part and bots their grants. Renames, merges and dismissals check it too. `403 page_protected`.
- **The patrol feed** (`server/changes.ts`, `/changes`, linked in the navbar; `GET /api/v1/changes`):
  - every commit to every page, newest first in the outbox's order, by kind;
  - bots hidden unless asked;
  - "only changes that move papers between topics": a topic's `broader` changed (read from the commit and its
    parent), merges and renames, also flagged "moves papers" in the full feed;
  - who made it as the history shows it (handle, a confirmed author's name on their paper, or the system).
- Migration `0039_topic_pages.sql`. New API error codes `page_merged`, `page_protected` and `topic_exists`. The public
  GETs are in `/openapi.json`; `llms.txt` and an `/agent/updates` notice describe the routes. DESIGN.md §4.3 (topic
  pages), §4.9 (the suggestions consumer) and §7 (`/changes`, protection), and IMPLEMENTATION.md (Milestone 3 and
  "Pages above the paper") are updated.

Calls I made where the plan left room:

- **Page protection and the patrol feed didn't exist** (Milestone 3), so this phase built the minimum the plan's
  "with page protection and the patrol feed" needs, for every kind: two levels and a feed. Watchlists, digests,
  one-click revert for keyed pages, new-account rate limits, reports and blocks are still Milestone 3. "Established"
  is time since the address was confirmed (4 days, like Wikipedia's autoconfirmed), not an edit count.
- **Protection holds the community's paths only.** Owners' parts (a paper's `author/`) and bots' grants aren't held,
  since protection is against edit wars, not a way to take a page from those it belongs to.
- **Merges keep the duplicate's page**, as paper merges do, marked `merged_into`, rather than deleting it and
  leaving only a redirect, so its history stays readable by clone. Its scope rows are cleared in the merge
  transaction, and the `members` consumer writes none for a merged page. After the merge, the survivor's membership is
  re-indexed at once, so it holds even when the fold changed no file.
- **A rename's metadata commit is the system's**, as a handle change is: only the system writes `.potentialpaper/`.
  The summary names who did it, so the feed shows it.
- **Suggestions from the map's nearest neighbours** wait for the map's vectors (the plan's "later").
- **Score sorting across venues** compares where each paper's mean sits in its venue's range (scales differ). A paper
  with several submissions shows its accepted one, else the latest. The list reads up to 5,000 papers and sorts them
  in memory; a topic that big would want SQL paging.
- **The topic's papers and suggestions are tabs**, below the article and its side boxes, so the page still reads as
  an article; both ids can be moved or hidden in settings like any panel's. The generic `about` panel is gone; each
  kind has its own.
- **"Add a topic" puts the link in `author/`** when a confirmed author adds it: the authors assert it as authors
  (§8's `origin`), under their `a_` identity.
- **Dismissing needs a verified account and respects the topic's protection**, as an edit would; confirming is an edit
  of the paper, so the paper's protection applies.
- **No topic search scope** (`kind:topic` in search): the plan lists search for every kind as a decision, not as this
  phase's work.

For later phases:

- One-click revert, history and diff pages are still paper-only. A topic's bad edit is undone by editing it again
  or by `git push`; the feed links to the page, not to a diff.
- Watchlists ("Following a page of any kind", Later) can feed off `recentChanges`.
- The suggestions' keyword match reads every submission's keywords when a topic changes. The seam, if it grows, is an
  index of the keywords' normalised words.
- Score standing doesn't declare topics (`handoffs/plugins.md` Phase 6). A topic's `page.hasScores` isn't a context
  key yet; adding it is a line in `KINDS.topic.contextKeys`.

Checks: typecheck, lint, prettier and `next build` pass. Unit tests: 404 pass. 9 of them are new, in
`tests/unit/topics.test.ts`: slugs, duplicate names, aliases, link ids, keywords, protection, sorting by score
across scales, and folding a merge.

Integration: 300 of 308 pass, 1 skipped (the network plugin test). The 7 failures are the same as before this phase:
six in `pdf-ingest.test.ts` (no poppler) and one in `follows.test.ts`. 10 tests are new, in
`tests/integration/topic-pages.test.ts`:

- making a topic, with duplicates refused by name, plural and alias, a taken address, the name lookup, and a missing
  broader topic;
- linking papers by name (the topic made) and by identifier, `exists` the second time, an author's link in `author/`,
  roll-up through `broader` with `via` and `introduced`, and the overview and paper routes;
- suggestions by keyword, title and abstract, confirm and dismiss, both surviving a rebuild;
- a rename's redirect keeping links, members and narrower topics, and the old slug taken again;
- a merge folding names, sections and links, moving members and a dismissal, refusing commits to the duplicate, and
  resolving to the survivor;
- protection levels for a fresh, an established and an admin account, set and lifted only by admins;
- the patrol feed's order, attribution, roll-up filter and paging;
- keywords through `submission.json` into the projection and suggestions, with papers sorted by their reviews' scores.

These ran against this worktree's own database, `potentialpaper_test_pages5`, through an untracked `.env`.
