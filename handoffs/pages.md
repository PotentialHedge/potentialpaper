# Handoff: pages above the paper (venues, topics, organisations, people)

Status: plan, 2026-11-16. Nothing here is built yet. Read with `handoffs/plugins.md`: plugins work on every kind of
page this plan adds.

## Goal

Today the site has one kind of page, the paper. Researchers also think in venues, topics and sub-topics, institutions
and labs, and people. Each of these becomes a page of its own, built the same way as a paper's: a git repo of small
files with path rules, derived data from outbox consumers, named slots, and file types that bots write and plugins
show. A plugin written once can then add a panel to a paper, a venue, a topic, an organisation or a person.

## Decisions (proposed 2026-11-16)

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
  - sections in `about/NN-*.md`, written like a paper's;
  - `links.jsonl` (labeled links from this page, to pages of any kind);
  - the kind file;
  - `extensions/<id>/` for plugins' and bots' data;
  - bot folders granted by path, as `reviews/<source>/**` is today.
- **Who may edit, as path rules per kind** (`rules.ts` gains the kind):
  - Venue: any verified account edits `about/`. The kind file and `sources` are for maintainers and admins. A
    maintainer is an organiser, granted by an admin as a bot grant is.
  - Topic: any verified account, subject to page protection. `parents` changes are patrolled, as a page's
    protection is.
  - Org: verified members (an affiliation whose domain is one of the org's `domains`) and admins.
  - User: the account itself, its agents' tokens, and admins.
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
- **Identity on user pages follows DESIGN.md §5.3.** A handle's page never publicly connects that handle to an author
  identity. It lists claimed papers only when the account shows its real name. Otherwise, claimed work appears only
  under the author identity on each paper. This is the one place where adding a kind can leak something, so the
  rule lives in the `user` kind's projection, not in its page component.
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
- Maintainer grants by script, as `bots:grant` does it.

### Phase 3: user pages

- `/u/<handle>`, which the profile page links to. `profile.json` holds what the account chose to show.
- `about/` is free text; `links.jsonl` holds links to homepage, ORCID, Scholar and to their own work. The §5.3 rule
  applies to every list on the page.
- Activity on the page (edits, links, comments under the handle) comes from the outbox. Bot commits are hidden, as
  in the feed.

### Phase 4: organisation pages

- An `orgs` bot seeds pages from `config/institution-domains.json` and `institution_domains`, with ROR ids where we
  have them. Departments and labs are child pages that verified members make.
- Shows members who chose to show their institution, the org's papers (rolled up from its children), and venues and
  topics by count.

### Phase 5: topic pages

- Seed top-level topics from the arXiv taxonomy, through a `topics` bot, with categories as `in-topic` links in
  papers' `links.jsonl` under the bot's grant. OpenReview keywords are suggestions, not links, until someone confirms
  them.
- Making a topic, choosing parents, merging and renaming: a merge leaves a redirect, as paper merges do.
- Shows sub-topics, papers (rolled up), venues where the topic is common, and orgs active in it.

### Later (not this plan)

- Embedding clusters as suggested topics, from the map's vectors.
- Workshops and tracks as venue children with their own sources.
- Following a page of any kind for the feed and notifications.

## Open questions

- User pages and author identities: should a person who shows their real name get one page that joins their handle
  and their author identities, or should author identities get pages of their own (`/a/<id>`), which a user page
  links to only by choice?
- Who maintains a venue page before any organiser claims it: only the `venues` bot, or the community as for topics?
- Is the arXiv taxonomy the right root for topics, or should topics start empty and grow from what people link?

## Log

**How the phases run:** one T3 thread per phase, on its own branch (`pages-phase-<n>`), cut from the previous phase's
branch so this file stays current. Commit and push after each working step. At the end, add your entry below and
launch the next phase's thread pointing at this file. Merging into `main` waits for Benedict.
Phase 1 comes before `handoffs/plugins.md` Phase 2, so the plugin host is built for every kind from the start.
