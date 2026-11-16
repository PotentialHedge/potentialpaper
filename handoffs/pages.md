# Handoff: pages above the paper (venues, topics, organisations, people)

Status: plan, 2026-11-16. Phase 1 (the page model) is built; see the Log. Read with `handoffs/plugins.md`: plugins work on every kind of
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

- Which items a user page can show, and their defaults (Phase 3).

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
