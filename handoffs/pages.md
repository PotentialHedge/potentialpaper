# Handoff: pages above the paper (venues, topics, organisations, people)

Status: plan, 2026-11-16. Nothing here is built yet. Read with `handoffs/plugins.md`: plugins work on every kind of
page this plan adds.

## Goal

Today the site has one kind of page, the paper. Researchers also think in venues, topics and sub-topics, institutions
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
| topic | `/t/<slug>`                                                                   | `topic:<slug>`     | `topic.json`: name, aliases, `parents` (a DAG, not a tree)                       |
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
  - Topic: community-run. Any verified account can make a topic and edit any topic's `community/`, `topic.json`
    (name, aliases, parents) and links, subject to page protection. Changes to `parents` show in the patrol feed,
    since they move papers between roll-ups. Topics the `topics` bot seeds are ordinary topics: the community edits
    them like any other, and the bot never overwrites a human edit (it writes only files it made, and stops at a
    file a person has changed).
  - Org: `members/` for verified members (an affiliation whose domain is one of the org's `domains`), `community/`
    for any verified account, and the kind file for members and admins.
  - User: only the account itself, its agents' tokens, and admins.
- **Membership is links and projections.**
  - A paper is at a venue through its submissions: the projection that already exists.
  - A paper is in a topic through a labeled link `in-topic` from the paper to `topic:<slug>`. It can be asserted by
    the community or by an author, or written by a bot under its own grant: arXiv categories, OpenReview keywords,
    and later embedding clusters.
  - A paper is from an org through confirmed author claims of verified members who chose to show their
    institution, and through the domains printed on page 1 (`pdf_documents.emails`).
  - One consumer keeps `page_members(scope_page_id, paper_id, via, weight)` from all of these. Every list, count,
    statistic and plugin query above the paper reads that table.
- **Hierarchies roll up.** A topic's papers include its descendants'. A series' papers are its editions'. An org's
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

- Seed topics from the arXiv taxonomy (archives as parents, categories as children: `cs` → `cs.LG`), through a
  `topics` bot, with categories as `in-topic` links in papers' `links.jsonl` under the bot's grant. OpenReview
  keywords are suggestions, not links, until someone confirms them.
- Anyone verified can make a topic: a "New topic" form, and a topic made on the fly when a link names a slug that
  doesn't exist yet, as a paper page is made on first visit. New topics can sit under arXiv ones or anywhere else.
- Editing a topic (name, aliases, parents, sections, links), merging and renaming is open to the community, with page
  protection and the patrol feed. A merge or rename leaves a redirect, as paper merges do.
- Shows sub-topics, papers (rolled up), venues where the topic is common, and orgs active in it.

### Later (not this plan)

- Embedding clusters as suggested topics, from the map's vectors.
- Workshops and tracks as venue children with their own sources.
- Following a page of any kind for the feed and notifications.

## Open questions

- Which items a user page can show, and their defaults (Phase 3).

## Log

**How the phases run:** one T3 thread per phase, on its own branch (`pages-phase-<n>`), cut from the previous phase's
branch so this file stays current. Commit and push after each working step. At the end, add your entry below and
launch the next phase's thread pointing at this file. Merging into `main` waits for Benedict.
Phase 1 comes before `handoffs/plugins.md` Phase 2, so the plugin host is built for every kind from the start.
