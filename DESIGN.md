# PotentialPaper — design

Status: draft for review, 2026-11-05. Updated 2026-11-16 with the data model for bots and plugins, search
and the scaling path (§3, §4.3, §4.4, §4.8–4.11, §10, §12).
The build order is in [IMPLEMENTATION.md](IMPLEMENTATION.md), and the work that follows from the 2026-11-16
decisions is in [handoffs/data-model.md](handoffs/data-model.md).

## 1. What this is

Every research paper gets one public page that verified researchers can edit, wiki style.
Each page has two parts:

- **The author section** is written only by the paper's verified authors. It replaces the polished
  project website that many papers now have, which is attractive but goes unreviewed. Here that
  material sits next to public scrutiny, under a permanent address.
- **The community section** is editable by any verified researcher: summaries, critique, errata,
  reproduction attempts and context.

**Labeled links between papers** are the central object. "B fails to replicate A" or "D extends C"
is a public claim with a named author, evidence, a history and a discussion. Together these form
an open peer-review graph.

Every page change is versioned as a git commit. The site can later be extended from GitHub repos,
in the spirit of VS Code extensions.

### Principles

1. **Reading needs no account and is fast.** Writing needs a verified institutional email.
2. **Who said it is always visible.** An author's words, the community's words and a bot's words
   never look alike.
3. **Git holds the documents and Postgres holds the social activity.** Anything people edit
   together is in git, and so is anything a bot imports onto a page, such as a venue's reviews, so it
   has a history too. Votes, comments and sessions are not.
4. **Git is the source of truth for page content.** Every page-content table in Postgres can be
   rebuilt from it.
5. **The UI is one client of the API**, as in acceptodds. Bots and extensions use the same API.
6. **The repo is the data, plugins are views.** Anyone can extend the site by writing a bot that commits
   files of a known type into pages (§10), and a renderer for a type of file shows it (§4.8). Our own
   importers are bots like anyone else's.

### Not in the first version

- Hosting PDFs. We link out, which avoids a large copyright problem.
- Formal review scores or reputation systems. An extension can experiment with these first.
- Real-time co-editing.

## 2. Stack

Same as acceptodds unless a reason is stated here. The reference is
[PotentialHedge/acceptodds](https://github.com/PotentialHedge/acceptodds), checked out locally at
`../papermarket/platform`.

| Concern | Choice                                                                          |
| ------- | ------------------------------------------------------------------------------- |
| App     | TypeScript, Next.js 16 App Router, Node 26, `output: 'standalone'`              |
| Data    | Postgres 19 with Drizzle; migrations are a separate deploy step (§4.11)         |
| Auth    | Better Auth: email-first sign-up, link plus 6-digit code, API keys              |
| UI      | Tailwind v4 with acceptodds' `globals.css` tokens and `components/ui.ts`        |
| Content | `react-markdown` stack with GFM and KaTeX, `d3-force` for the graph             |
| Mail    | Resend                                                                          |
| Tests   | Vitest and fast-check; integration tests against real Postgres                  |
| Hosting | One app and one Postgres container behind Traefik and Cloudflare                |
| Added   | Cloudflare R2 for uploaded media; `node-diff3` and `diff` for merging and diffs |

**Copy from acceptodds, don't share a package.** The two products will diverge, and a shared
package would slow both. Good candidates to copy are `better-auth.ts`, `onboarding.ts`,
`institution-domains.ts` with its config and build script, `ratelimit.ts`, `mail.ts`, `tokens.ts`,
`server/api/` (Zod, OpenAPI, error codes), `Markdown`, `MarkdownEditor`, `Pager`, `Modal`,
`Popover`, the compose files, the Dockerfile and `pg-backup.sh`. Trading code is not copied.

**Look:** keep the "arXiv digest" style: serif body, small-caps numbered sections, booktabs tables,
monospace numbers, one maroon accent. Only the wordmark and logo change.

**One deliberate difference from acceptodds: anonymous pages are cached at the edge.** Its root
layout reads the viewer on the server, so every page is dynamic. Here a paper page is the same HTML
for all readers, with viewer-specific parts (edit buttons, watch star) in client islands. Cloudflare
caches it and each commit purges it. This is the largest single speed gain on the read path.

## 3. Papers and identity

A paper is a **work**, not a version: arXiv v1 to v5 and the published version share one page.
The versions themselves are listed in the page's `versions.jsonl` (`lib/versions.ts`): each preprint,
workshop and conference submission, with its date, what the venue decided, its own PDF and the evidence
for it. Anyone verified edits them (with evidence), the system imports them from OpenReview and arXiv
(`npm run papers:import-versions`), and `/versions/<paper>?a=&b=` compares two: title, abstract, and
the PDFs' text sentence by sentence, from the ingest's `fulltext` stage.

```
papers(id ulid pk, title, authors jsonb, abstract, year, venue, created_at, merged_into null)
paper_identifiers(scheme, value, paper_id, pk(scheme, value))   -- arxiv, doi, openreview, ...
```

- **Addresses copy arXiv's.** `/abs/1706.03762` and `/doi/10.1145/...` are the canonical URLs, so
  changing the domain in an arXiv link opens the same paper's page. Internal ids never appear in URLs.
- **Pages are created on demand.** The first visit to a valid identifier fetches metadata and makes
  the row. Lookups are rate limited and misses are cached, so crawlers can't drive it. Bulk seeding
  can come later through the same adapters.
- **Source adapters** cover arXiv and OpenAlex or Crossref first. Check each source's current rate
  limits and metadata license before bulk use, publisher abstracts especially.
- **Everything imported records its source and license.** A paper row keeps `source`,
  `metadata_license` and `abstract_license`, `pdf.json` keeps `license`, and anything imported later
  (venue reviews, paper text) gets the same. Licenses are SPDX ids where the source names a version
  (`CC0-1.0`, `CC-BY-4.0`) and the source's own label otherwise. arXiv and OpenReview dedicate
  metadata, abstracts included, to CC0; OpenAlex's data is CC0 but an abstract keeps the work's own
  open license, and is dropped without one. OpenReview reviews, scores and comments are CC BY 4.0,
  which requires attribution and a link on every one we show.
- **Submissions and their reviews are imported by bots into the page's repo** (decided 2026-11-16; until
  it is built they are in the `submissions` and `submission_notes` tables). Each source writes
  `reviews/<source>/<submission>/` (§4.3): the submission (venue, status, decision, link, the version it
  is of), the venue's forms, and one file per note: reviews, meta-reviews, decisions and comments,
  threaded by `reply_to`, each with its license and link. Only notes the source shows everyone are
  imported. Only that source's bot writes its folder, nobody edits them on the site, and a re-import
  commits only what changed, so a reviewer raising a score is a commit in the page's history. The
  tables stay as a projection of those files (§4.9), for listings across papers such as a venue's
  scores. Nothing is venue-specific: the forms give each kind of note its labels, field order, score
  ranges and summary columns, and fields no form names are shown by what their values look like.
- **Duplicates get merged.** A moderator, or an admin by script, sets `merged_into`. The old address redirects,
  and its repo's content is folded into the survivor with one commit that records where it came
  from. Links resolve through the merge when read.

## 4. Each page is a git repo

### 4.1 Decision: real git objects, stored in Postgres

A page's history is a **real git repository**: real blobs, trees and commits with real SHA-1 ids,
and a stock `git clone` works. The objects are rows in Postgres instead of files on disk.

```
pages(id pk, kind, key, unique(kind, key))             -- every page of every kind; a paper's id is its paper id
page_refs(page_id pk, head oid)                        -- the only mutable part of a repo
page_objects(page_id, oid, type, body, pk(page_id, oid))
```

Git's object format is simple enough that hashing and writing objects takes roughly 200 lines of
TypeScript. `git fsck --strict` acts as the test oracle in CI.

**Why not a bare repo on disk per page?** Page content would then live in two systems, with no
transaction spanning them. A crash between the git write and the Postgres write leaves the page and
its index disagreeing, which then needs reconciliation code. In Postgres, one transaction covers the
objects, the head, the rendered page, the link index and the feed. Backups also stay a single
`pg_dump`, using the restic setup acceptodds already has.

**Why not one big repo with a directory per paper?** Every edit would contend on a single ref, per-path
log gets slow as the repo grows, and redacting one page would rewrite everyone's history.

**Measurements.** Reproduce with `spikes/git-store.mjs`. Synthetic pages with an 11 KB document, on
this shared 16-core host under other load, with Postgres at default settings:

|                                              | Postgres objects                        | Bare repos, `git` plumbing                                 |
| -------------------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| Write a commit, p50 / p99                    | 11 / 37 ms (8 connections)              | 160 / 177 ms (serial)                                      |
| Throughput                                   | 619 commits/s                           | about 6 commits/s                                          |
| Storage, 20-revision page                    | 23 KB including indexes                 | 655 KB, 164 inodes; 72 KB, 17 inodes after `gc` (one page) |
| Read current page / history                  | 1.2 / 1.5 ms                            | not measured                                               |
| Spike: dumb `git clone`, 20 commits          | 334 ms, 85 requests                     | not measured                                               |
| Spike: dumb `git clone`, 500 commits         | 3.5 s, 2005 requests                    | not measured                                               |
| Smart HTTP clone, 20 / 500                   | 0.1 / 0.6 s, 3 requests                 | not measured                                               |
| Dumb HTTP clone, 20 / 500                    | 0.24 / 2.0 s, 94 / 2062 requests        | not measured                                               |
| Smart / dumb fetch of 1 new commit after 500 | 0.15 s, 3 requests / 0.06 s, 6 requests | not measured                                               |

Read the write gap with care. The disk column forks 8 `git` processes per commit, and an in-process
library or `git fast-import` would narrow it substantially, so forking explains much of that gap and
storage may explain little. **The deciding argument is atomicity and operational simplicity, not
raw speed.** Expected write rates are far below either figure. The Postgres timings include the
object insert, ref update, revision row, projection and link index, but not Markdown rendering or
merging. Conflict handling was not exercised. Clones were tested on git 2.34.1 over loopback,
without a CDN. Every clone passed `git fsck --full --strict`. The first two clone rows are the spike's; the
smart and dumb rows are the app's own route (`server/git/`, §4.6) in one process with the dev Postgres, a
page whose summary file is 9 KB and changes every commit, best of three runs (2026-11-13).

**What this costs.** We own a small piece of git-format code (objects, packs both ways, the smart protocol),
there are no hooks, and tools that expect files on disk need a clone first. Nothing is locked in: `git clone` of any page
gives a normal repo.

**Scale check.** At the measured 23 KB per page, one million actively edited pages come to about
23 GB, which one Postgres handles comfortably. The primary key leads with `page_id`, so hash
partitioning remains available later.

### 4.2 A repo exists only after the first edit

A page nobody has edited is a `papers` row with no objects. Millions of stubs therefore cost almost
nothing, and the first commit creates the repo with a metadata snapshot.

### 4.3 Repo layout, and permissions by path

A repo is laid out so that a person with a text editor can edit it: many small files, folders over
big files. `src/server/pages/rules.ts` is the authority.

```
.gitattributes                  system, always the same: which files are Git LFS
.potentialpaper/metadata.json   system: layout version, identifiers, title, authors, abstract snapshot
.potentialpaper/paper.pdf       system: the paper's PDF (Git LFS)
.potentialpaper/pdf.json        system: its source page, license and when it was fetched
author/10-tl-dr.md              the author section, one file per section
author/20-results.html          … in Markdown or HTML
community/10-summary.md         the community section, the same way
versions/v_k3x9q2ab.json        a version of the paper; the file's name is its id
versions/v_k3x9q2ab.pdf         that version's PDF (Git LFS)
links/10-code.json              a link under the title: { "label", "url" }
thumbnail.gif                   the paper's picture, in place of its PDF's first page (Git LFS;
                                .png, .jpg, .gif, .webp or .avif, named for its type, one a page)
thumbnail.json                  the picture's words: { "alt", "caption" }
demos/<name>/index.html         a demo kept in the page, with the files it loads beside it
reviews/<source>/<submission>/submission.json   a bot's import: the submission (§3, §4.8)
reviews/<source>/<submission>/forms.json        the venue's forms for its notes
reviews/<source>/<submission>/notes/<id>.json   one review, decision or comment
extensions/<id>/...             reserved: data owned by one extension (section 10)
```

**Pages of every kind** (decided 2026-11-16, built in `handoffs/pages.md` Phase 1). A paper is the first kind of
page; venues (`/v/iclr/2027`), topics (`/t/<slug>`), organisations (`/o/<slug>`) and people (`/u/<handle>`) are
pages built the same way, each a repo with the same shape: `.gitattributes`, `prek.toml` and
`.potentialpaper/metadata.json` (`{ layout, kind, key }`) for the system; its parts' sections, the owners'
(`author/` on a paper, `organizers/`, `members/`, `about/`) and `community/` (all but a user's); each part's
`links.jsonl` (§8); its kind file (`venue.json`, `topic.json`, `org.json`, `profile.json`); and `extensions/`. The
kind registry, `src/lib/kinds.ts`, declares each kind's address, kind file and schema, parts, slots
(`<kind>.main`, `<kind>.aside`, `<kind>.tabs`), file types and plugin context keys, and `rules.ts` takes the
page's kind. Every table of the page store is keyed by `page_id` (`pages(id, kind, key)`); a paper's page id is its
paper id. Other kinds' pages are made by `createPage` (`npm run pages:create`), which starts their repo with the
system's commit, and are cloned and pushed at `/git/<kind>/<key>.git` (or over SSH at their own address).

**Sections** are named `NN-slug.md` or `NN-slug.html`: two digits, then a lower-case ASCII slug.
They show in the order of their names, which is the order `ls` lists them in. A section's title is the
`#` heading (or `<h1>`) its file starts with, and otherwise its slug. HTML is checked against an
allowlist at commit (no scripts, styles, event handlers, ids or classes) and refused, not cleaned, so
what is in the repo is what is shown. Links are numbered the same way.

**The layout has a version**, `LAYOUT_VERSION` in `rules.ts`, which `metadata.json` records as
`"layout"`: the first commit writes the current one, and each move to a new layout
(`layout-migration.ts`) writes its own. A breaking change to the layout raises it, so that we can tell
which repos are laid out which way. Repos from the first layout have no `"layout"`.

**`.potentialpaper/`** is the one directory that may start with a dot, at the top and spelled exactly
so, and `.gitattributes` at the top the one file; every other path rule stays. `.gitattributes` has fixed
content (`GITATTRIBUTES`): it marks the PDFs and the picture `filter=lfs`, and nothing else, since an
attribute can name a filter and filters run programs on a clone.

**Permissions are rules on paths**, checked in one place:

| Path                      | Who may commit                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `.potentialpaper/**`      | System ingest, admins                                                                       |
| `.gitattributes`          | System, admins, and only its fixed content                                                  |
| `versions/**`             | Any verified account, system ingest, admins                                                 |
| `thumbnail.*`, `links/**` | Confirmed authors once claimed, any verified account before, admins                         |
| `author/**`               | Confirmed authors of this paper, admins                                                     |
| `community/**`            | Any verified account, subject to page protection                                            |
| `demos/<name>/**`         | Any verified account; a folder the author section shows, only its confirmed authors; admins |
| `reviews/<source>/**`     | Only the bot granted `<source>` (`openreview` is our importer), admins                      |
| `extensions/<id>/**`      | Extension `<id>` acting for a consenting user                                               |

`<source>` and `<submission>` are lower-case slugs: the source's id for the submission (an OpenReview
forum id) where it is one. Grants of a folder to a bot are data, not code (§10, "Bots").

**Demos** are code that runs on the page, in a sandboxed frame from a host of their own
(`lib/demos.ts`, served by `server/demos/serve.ts` at `/d/<snapshot>/…`). Either section embeds one
with a fenced block whose info string names it, the title on its first line and a description after:

````
```demo https://github.com/you/demo/tree/v1.2/dist
Attention, in 3D
Rotate it.
```
````

The name is one of:

- **A GitHub address**, as GitHub prints it: `https://github.com/<owner>/<repo>`, optionally with
  `/tree/<branch, tag or commit>/<folder>` (or `/blob/…/index.html`), or a gist. When the commit that
  puts the address on the page comes in, the server copies the files (git's ref listing, then
  codeload's tarball; the folder with `index.html`, or the first of `dist`, `build`, `docs`, … that has
  one) and records the snapshot in `demo_pins`, keyed by page and address. The file keeps the address
  as written: a pushed commit is stored verbatim, so the server never rewrites one. The pin holds while
  the address stays anywhere on the page, so later edits don't move a branch's demo; taking the block
  off and adding it again in a later commit copies it again, and naming a tag or commit pins it
  exactly. A copy that fails refuses the commit with GitHub's reason. At most 5 new addresses a commit.
- **`demos/<name>`**, a folder of the page's own repo with an `index.html`. Its files are text only
  for now (`.html .js .mjs .css .json .svg .glsl …`, valid UTF-8): pictures go in as SVG, and a demo
  with binary files comes from GitHub instead, whose copies go to the blob store, so that binary blobs
  don't grow every page's history in Postgres. Up to 1 MB a file, 300 files and 5 MB for all of a
  page's demos; a commit may change up to 300 demo files besides its 50 others. When a page's
  projection is written, each folder a block names becomes a snapshot like a copied one (its id a hash
  of the page, folder and blob ids), so both are served and sandboxed the same way. A block may only
  name a folder that is there, and a commit can't delete a folder a block still names. Anyone verified
  may add a folder, as they may write the community section, but once the author section shows one,
  only the paper's confirmed authors and admins may change it, since what runs there speaks for them.
- **A snapshot id** (32 hex digits), as the editor's "Insert a demo" writes it after copying a demo
  through `POST /api/v1/demos`. A block naming an id the site doesn't have is refused.

These rules are checked inside `commitPage` (`server/demos/attach.ts`), so they hold for any writer.
Each demo is served from a host of its own on a separate domain, `<snapshot>.ppusercontent.com` (`lib/demos.ts`),
so it shares no site with the app and no origin with another demo.

**Media is Git LFS.** PDFs and the picture don't go in git: their bytes go to R2, keyed by SHA-256, and
the repo has a Git LFS pointer (`version …`, `oid sha256:…`, `size …`), so a clone with `git lfs`
installed has the files and `git add` of one stores a pointer. `lfs_objects` records every file this
site stored, with its type (read from its bytes) and where it is (`server/lfs.ts`); a commit's pointer
has to name one, of the right size and kind (a PDF at a `.pdf` path, a picture of the type its name
says), whoever commits it (`check.ts`). The bytes come in three ways: `git lfs` through the batch API
at the clone address's `info/lfs/` (`server/git/lfs.ts`: downloads are R2 addresses, for anyone;
uploads are a `PUT` back to the site with the push API key, kept only if they are a PDF or a picture),
the web editors (the picture, a version's PDF uploaded or copied from an archive), and the imports.
Pages have no LFS locks; the locks API answers 501, which `git lfs` takes as "turn lock checks off".
Taking a file down deletes its bytes; history keeps the pointer, which then shows nothing. What the
page shows is projected from the pointer, the JSON beside it and `lfs_objects` (`page_current.pdf`,
`.thumbnail`, each version's `pdf`).

### 4.4 The write path

`commitPage(paperId, baseOid, actor, changes, summary)` writes a web edit, as `engine.trade()` is in
acceptodds, and `receiveCommits` (`pages/receive.ts`) writes commits a git client pushed. Both decide
what may change in **one** function, `checkTree(before, after)` (`pages/check.ts`), and store through
one, `recordCommit`, so no route checks anything a tree written by hand could get around. Within one
transaction a commit:

1. Checks the actor's roles, rate limits and, per changed path, permissions and the layout.
2. Validates files (JSON shapes, the HTML allowlist, pointers) and the tree (limits, link labels, version
   PDFs uploaded here, the picture's address, demos). Copies of GitHub demos are made only once these
   pass, before the lock.
3. For a web edit, if `baseOid` is not the head, runs a three-way merge per file. A real conflict returns
   `409` with both versions, and the editor shows them.
4. Writes blobs, trees and the commit.
5. Moves the head with compare-and-swap, `UPDATE ... WHERE head = $base`.
6. Updates `page_current`, `page_links`, `page_revisions` and the event outbox.

After commit the route purges the Cloudflare URLs for the page and its link targets.

Only what the page itself shows is written in the commit's transaction, so an editor always sees their own
edit. Everything else derived from a commit (the search index, the review tables, webhooks to bots) is a
consumer of the outbox (§4.9) and catches up within seconds.

**Pushed commits are stored verbatim**, so their ids don't change, and only if: author and committer are
exactly the identity the site gives that account on that page (`u_…`, or the per-claim `a_…` on a paper it
is an author of; `gitIdentity` says which `user.name`/`user.email` to set); they are a fast-forward of the
head with no merge commits; they carry only git's own headers (no signature, which names a key) and a
one-line summary; and their trailers are only `Evidence:`, `Edit-Kind: revert` with `Reverts:`, and
`Bot: true` from a bot. A message line with a name and address is refused. A push is all or nothing.

Details that have to be right:

- **Tree entries sort by raw bytes**, with directories compared as `name/`. Locale sorting produces
  repos that clone but fail `git fsck`; the spike hit exactly this.
- **Commit authors are pseudonymous and stable:** `u_7k3x <u_7k3x@users.invalid>`, never an email or
  legal name. The site maps the id to a current name through `page_revisions`. Deleting an account
  removes that mapping without rewriting any history.
- **Named author identities get their own id.** Commits made as a paper's named author (section 5.3)
  use a per-claim id such as `a_9f2c`, which can't be connected to the person's `u_` id from public
  data. `page_revisions.account_id` is private, and public reads only ever return the commit's id.
- **Commit trailers carry context:** `Edit-Kind: revert`, `Author-Of-Paper: true`,
  `Extension: <id>`, `Bot: true`.

### 4.5 The read path

Reads never touch git objects.

```
page_current(page_id pk, head, author_html, community_html, ..., kind_file jsonb, name, updated_at)
page_revisions(page_id, seq, oid, account_id, kind, summary, paths[], bytes_delta, at, pk(page_id, seq))
page_links(page_id, path, link_id, target, target_kind, target_page_id, label, origin, note, ...)
```

Markdown is rendered and sanitized **at commit time** and stored as HTML. Raw HTML in Markdown is
never allowed. History pages read `page_revisions`, and diffs are computed in-process from blobs
and cached by oid pair.

### 4.6 Clone and push access

Clones, fetches and pushes use git's **smart protocol** over HTTPS and over SSH, implemented in TypeScript over
`page_objects` (no repos on disk, no `git` process on the server), with HTTP's read-only **dumb protocol** kept
beside it:

```
GET  /git/arxiv/1706.03762.git/info/refs?service=git-upload-pack   smart: capabilities (v2) or refs (v0, v1)
POST /git/arxiv/1706.03762.git/git-upload-pack                     smart: ls-refs, fetch → one packfile
GET  /git/arxiv/1706.03762.git/info/refs                           dumb: refs
GET  /git/arxiv/1706.03762.git/HEAD                                dumb
GET  /git/arxiv/1706.03762.git/objects/ab/cdef...                  dumb: one loose object
GET  /git/arxiv/1706.03762.git/info/refs?service=git-receive-pack  push: refs and capabilities (API key)
POST /git/arxiv/1706.03762.git/git-receive-pack                    push: commands and a pack → status report
```

`src/server/git/` holds it, the transport kept apart from the protocol, so HTTP and SSH share it: `pkt-line.ts`
(framing, side-band), `pack.ts` (packfile writer: whole objects, no deltas, zlib, SHA-1 trailer),
`pack-reader.ts` (packfile reader: deltas by offset and by id, thin packs, capped), `repo.ts` (`GitRepo`: head,
commits, objects by id; `pageRepo` reads Postgres), `walk.ts` (what to send), `upload-pack.ts` and
`receive-pack.ts` (the protocols, each as one stateless HTTP request or a session on a byte stream),
`page-push.ts` (a page as the target of a push), `http.ts` (the route's adapter) and `ssh.ts` with
`ssh-command.ts` (the SSH server, below).

- **Versions.** Protocol v2 (git's default since 2.29: `ls-refs`, `fetch`), and v0/v1 with
  `multi_ack_detailed` and `side-band-64k`, for older clients and libraries. Shallow clones (`--depth`) are
  refused by git itself because the server doesn't offer them; `--filter` is ignored by git for the same reason.
  No tags, no deltas (packs are bigger than git's, but cost no search).
- **What a fetch sends.** All of the page's commit rows are read in keyset pages of 2,000 (they are small), the
  walk runs in memory, and trees are read a level at a time in batches. Objects reachable from the client's
  common commits are skipped, comparing trees only at the edge as git does. The pack streams out as rows are
  read, 64 objects a query, so memory holds the object list, not the pack. Caps: 100,000 commits, 200,000
  objects a pack, 4 MB of request. Wants must be reachable from the head.
- **Caching.** Only loose objects are cacheable (`s-maxage`, edge only, by the `.git/objects/` cache rule); they
  never change meaning. The smart answers are `no-store, no-transform` (so neither Next nor the edge
  recompresses a pack), and Cloudflare never caches a POST.
- **Rate limits.** As before: Traefik's own `/git/` router (200/s, burst 1500 per client IP), sized for dumb
  clones. A smart clone is three requests.

**Push.** `git push` to the clone address, with an API key as the password (`server/auth.ts`
`authenticateGitPush`): HTTP Basic with any user name, so one credential-helper entry per host serves every page,
or `Authorization: Bearer`. The key needs the `push` scope (a key that can do nothing else, the one to keep in a
credential helper) or `write`, and its account a confirmed address. Without credentials, or with a key that
isn't one, the answer is `401` with `WWW-Authenticate: Basic`, which is what makes git ask for them; a key that
may not push or an unconfirmed account gets `403` and a sentence git prints. The flow:

- `info/refs?service=git-receive-pack` advertises `refs/heads/main` with `report-status`, `side-band-64k`,
  `quiet`, `atomic`, `ofs-delta`, `object-format=sha1` and `agent`. Not `delete-refs` (git then refuses a delete
  itself), `push-options` or `push-cert`. Protocol v2 has no push, so a client asking for it gets v0.
- The POST carries the commands, then the pack. A command for any ref but `main`, a tag or a delete is refused
  per ref (`ng`, with a `remote:` line saying why). The pack is read whole (≤ 32 MB as sent, ≤ 50,000 objects,
  ≤ 4 MB an object inflated, ≤ 128 MB held in all, so no delta bomb gets far), its trailer checked, its deltas
  resolved, a thin pack's bases read from `page_objects`.
- `main`'s update goes to `receiveCommits` (§4.4) with the pack's objects, so every pushed commit meets the
  same rules as a web edit, and is stored verbatim. A refusal's message goes back on side-band 2, so git prints
  each line as `remote: …` (the wrong-identity one lists the two `git config` commands on lines of their own),
  and the status report says `ng refs/heads/main <short reason>`. After a push the paper's pages are refreshed
  as after a web edit (`refreshPaperPages`).
- `proxy.ts` skips `POST …/git-receive-pack` (its `matcher`), since Next buffers a body for the proxy and cuts
  it off past 10 MB; the route refuses the user content domain itself. Cloudflare's own limit on a request (100 MB) is
  above the pack cap.

**SSH.** The same sessions on an SSH channel, as GitHub serves them (`server/git/ssh.ts`, `ssh2`): user `git`,
public-key auth only, and the key names the account (`ssh_keys`: Ed25519, ECDSA, RSA ≥ 3072 bits; the SHA256
fingerprint unique across accounts; added and removed on the profile page through `/api/v1/me/ssh-keys`, by a browser
session only). The only commands are `git-upload-pack '<path>'` and `git-receive-pack '<path>'`, the path quoted as
git quotes it and parsed strictly (`ssh-command.ts`): the page's own path (`abs/1706.03762`, `doi/…`, `openreview/…`)
or the HTTPS address's (`arxiv/…`, `git/arxiv/…`), with or without the leading slash and `.git`, then `findRepo`, its
redirects followed. `GIT_PROTOCOL` (sent with `SendEnv`) chooses v2 for fetches. No shell, pty, forwarding, agent or
subsystems: a bare `ssh git@host` gets "Hi <handle>! You've authenticated, but PotentialPaper does not provide shell
access." and exit 1, another command `Invalid command` and 128. Any key may clone; pushing needs what HTTPS needs (a
confirmed address, or a bot account), refused on stderr, which git prints. Every command counts against the account's
API bucket, and the server caps connections (in all, per address, a per-address bucket of new ones), key attempts,
the time to sign in, a connection's life and the commands one account runs at once (`SSH_LIMITS`).

It is its own process (`npm run git:ssh`, the `ssh` compose service from the tools image), published on the host
directly, since Cloudflare doesn't proxy SSH: a DNS-only name and a port to choose (DEPLOY.md). `revalidatePath` only
works inside a Next request, so after a push it asks the app (`APP_INTERNAL_URL`) to revalidate the paper's paths
through `POST /api/internal/revalidate`, authorized by a key derived from `BETTER_AUTH_SECRET`; scripts that commit
get the same through `refreshPaperPages`. The host key comes from a file or the environment and must never change in
production; dev makes one in `data/` on first start.

How to clone, set the identity and push, over HTTPS or SSH, is written up for people in `docs/git.md`.

### 4.7 Redaction

Git history is immutable, but libel, doxxing and legal takedowns require removal. Redaction is a
rare admin action, run as a script, that rewrites that one page's commits from the bad one onward, replacing the blob,
and records the old-to-new oid map and the reason in a public log. Existing clones keep the old
history and diverge. Having a repo per page limits the damage to one page, which is a real
advantage of this model.

### 4.8 File types: the contract between bots and plugins

Decided 2026-11-16. Every kind of file a page can hold is registered once, with:

- **a path pattern**, such as `versions/*.json` or `reviews/*/*/notes/*.json`;
- **a schema** (zod; JSON Schema is made from it for editors and bots, as `server/pages/schemas.ts`'s
  `PAGE_SCHEMAS` already does). A file of a type that can change shape names its version inside it,
  `"schema": "review/1"`. A new version is a new schema beside the old one, so files already committed
  never need migrating;
- **an indexer**, which turns a file into search documents (§4.10) and rows of any projection the type has;
- **a renderer**, which shows it on the page.

The commit path checks every file against its type, whoever writes it, so a bot that writes valid
`review/1` files is shown and found with no code from us. Renderers start as built-in panels in the
page's named slots; with extensions (§10) a renderer for a pattern can come from an extension, and a
reader can turn a built-in one off or replace it. Built-in types: sections, links, versions, the picture,
the PDF, demos, and from 2026-11-16 submissions, forms and notes (`review/1`).

### 4.9 Derived data: the outbox and its consumers

Decided 2026-11-16. `page_events` (one row per commit, written in its transaction) is the only way
derived data outside `page_current` learns of a change. Each consumer (the search indexer, the review
projection, webhooks to bots, later feeds) keeps its own cursor in a table and does one idempotent job,
"bring page P up to head H": it reads the page at that head and replaces what it holds for P. Replaying
an event is harmless, an event that arrives late for a page already past it is skipped by `seq`, and
rebuilding a consumer's data is resetting its cursor to zero.

Now: one worker process (a compose service, like `ingest`) reads `page_events` in order, woken by
`LISTEN/NOTIFY` from the commit, with a poll as a fallback. Later, the same consumers can sit behind a
queue (Kafka, NATS or a cloud queue), partitioned by `page_id` so each page's events stay in order.
This is how GitHub's code search is fed: pushes go to Kafka, and crawlers turn them into documents.

### 4.10 Search

Decided 2026-11-16. Everything in a repo is searchable, whoever wrote it:

```
search_docs(page_id, path, blob_oid, kind, text, fields jsonb, tsv tsvector)   -- GIN on tsv
```

The search consumer (§4.9) writes it from each file's indexer (§4.8): a section's text, a review's
fields, a link's label. Keyed by blob id, as GitHub's index is, so an unchanged file is never indexed
twice. A hit names the file, so results can point at the review or section that matched, and the query
syntax (`lib/query.ts`) gains scopes such as `in:reviews` and `in:page`, and later filters on fields a
form marks as scores. `papers.search` (title and abstract) stays for ranking papers. `server/search.ts`
remains the only way to query, so Postgres full text can later be swapped for OpenSearch or
Meilisearch, fed by the same consumer, if it gets slow (tens of millions of documents).

Built 2026-11-16 (Phase 4 of `handoffs/data-model.md`): the `search` consumer (`server/search-index.ts`) and
scopes `in:paper` (titles and abstracts, the default, so a plain search is unchanged), `in:page` (sections, links,
versions, the picture's words), `in:reviews` (submissions and notes) and `in:all`. The words of one term must be in
one file; each hit lists its best few matching files with a snippet. `search_docs` also has `scope` and a per-file
document number `n`; a file's blob id is checked before it is read again.

### 4.11 Scaling path

Decided 2026-11-16: build for one server, with seams that let each part grow on its own. GitHub's Git
storage (rebuilt in 2026) has the same shape as ours: refs in a small store updated by compare-and-swap,
objects in object storage, and servers that are only caches. Our refs are `page_refs` and our objects
are `page_objects`.

| Seam                                                                                                | Now                                   | Upgrade when it hurts                                                                                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **One object store interface** (`GitRepo`, `server/git/repo.ts`): nothing else reads `page_objects` | Object bodies are Postgres rows       | Bodies to R2 as packs, a pack manifest per repo in Postgres, refs stay in `page_refs` (~100 GB of objects) |
| **The repo is the unit**: every table keyed by `page_id` first, one repo per transaction            | One Postgres                          | Partition or shard by `page_id` (e.g. Citus), several writers                                              |
| **Derived data through the outbox** (§4.9)                                                          | One worker reading `page_events`      | A queue partitioned by `page_id`                                                                           |
| **Search behind `server/search.ts`** (§4.10)                                                        | Postgres full text on `search_docs`   | An external search engine fed by the same consumer                                                         |
| **File types and bot grants are data** (§4.8, §10)                                                  | A registry in code, grants in a table | Types from extensions                                                                                      |

Merging two papers is the one write across repos, and stays rare. Not now: queues, sharding, packs in R2,
an external search engine, more than one region.

**Postgres 19** (released 2026-11-19) suits this, since most of our big tables only grow
(`page_objects`, `page_events`, `search_docs`): queries now mark pages all-visible, so those tables need
less vacuuming; autovacuum vacuums indexes in parallel (`autovacuum_max_parallel_workers`, off by default,
turn it on) and orders tables by a score (`pg_stat_autovacuum_scores`); `REPACK (CONCURRENTLY)` reclaims
space after a large re-import without locking; TOAST defaults to lz4. The official image keeps its data
under `/var/lib/postgresql/<version>/docker` since 18, so the volume mounts at `/var/lib/postgresql`. The
upgrade from 16 is a dump and restore, which also rebuilds the full-text and `pg_trgm` indexes as 19's
release notes ask.

## 5. Accounts and institutions

### 5.1 Who can join

Institutional email is the only way in, and the rules are acceptodds' own, which were each learned
in production:

- **Email first:** address, domain check, one mail with a link and a 6-digit code, then profile and
  password after confirming. Answers don't reveal whether an address already has an account.
- **The allowlist** is generated from swot, ROR and Hipo (about 55k domains). Research companies and
  gaps go in a curated file, which wins on a clash and has an `exclude` list. Copy both the file and
  the build script.
- **Matching:** subdomains match, and matching never goes below two labels.
- **One inbox, one account:** addresses with a `+tag` are refused, a confirmed address vouches for
  only one account, and email changes are off, since a changed address would bypass the allowlist.
- **Refusal is a `422 EMAIL_DOMAIN_NOT_ALLOWED`, not a 403.** Better Auth answers a 403 from user
  creation with a fake success, so the person would wait for a mail that never comes.
- **Several affiliations:** extra addresses are added from `/profile`, each confirmed by its own code
  (`affiliations`). They also serve as evidence for author claims (section 6).
- **Unconfirmed sign-ups** are pruned weekly.

acceptodds built ORCID sign-in and removed it, so **ORCID is not a way to join here**. It is used only
as evidence for author claims. People with no eligible address can't join until their institution is added.

Reading never requires an account.

### 5.2 Adding an institution

There is no request form and no admin UI. A refused address is told its institution isn't on the list.
An admin adds a missing domain with one SQL insert into `institution_domains(domain pk, name, added_by,
created_at)`, which is read on every check, so it works at once with no restart. The curated file's
rule applies: only a domain whose mailboxes the organization gives to its own staff. Lasting additions
go in the curated file.

Roles are `admin` (by env, as acceptodds does it) and `moderator`. **Admins get no UI.** What only an
admin does, such as adding a domain, merging duplicates, redacting or making an extension default, is
done with scripts or SQL on the server.

### 5.3 Public identity

**Real names are optional.** Verification proves to us that someone belongs to an institution, and
what they show publicly is their choice.

```
accounts(id, user_id, handle unique, real_name null, show_institution, ...)
```

| Where                | Shown as                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Page edits and links | Handle, plus real name and institution if the person chose to show them. Always a "verified" mark                                       |
| Comments             | The same, or per-comment **anonymous**: a per-paper alias such as "Verified researcher k3xm", using acceptodds' `comment_aliases` model |
| Your own paper       | **Always your name as listed on the paper**, with an author badge                                                                       |

- Showing the institution is an explicit choice during onboarding. At a small institution, it can
  identify someone on its own, and onboarding says so.
- Anonymous is for comments only. Edits stay under a handle, because patrolling depends on seeing an
  editor's track record across pages.
- Moderators can always see the real account, so anonymity is from the public and not from the site.
  Abuse consequences apply to the account behind an alias.

**On your own paper you are always named.** This is what makes optional real names and honest
conflict-of-interest marks compatible. Once someone has a confirmed claim, everything they do touching
that paper uses a separate per-claim author identity, shown with the name on the paper:

- author section edits
- community section edits on that paper
- links with that paper at either end
- comments on that paper, where the anonymous option is unavailable

Their handle never appears on that paper, so nothing publicly connects a pseudonymous handle to a real
name. Stances on links touching your own paper don't count towards totals.

**Known limits.** Writing style and timing can still identify people, and this protects against casual
linking rather than a determined investigator. Someone who hasn't claimed their paper can still praise
it under a handle, so claiming stays voluntary and that gap has to be handled by normal patrolling. The
activity from before a claim keeps its handle, so the claim flow warns if the account has already acted
on that paper.

## 6. The author section

### Claiming authorship

The author section speaks in the authors' voice, so a wrong claim here is impersonation. An
institutional email alone proves nothing about authorship, and name matching is only ever a hint.

```
author_claims(paper_id, author_index, account_id, method, evidence jsonb, status, decided_by, at)
```

| Route              | Evidence                                                                                          | Result          |
| ------------------ | ------------------------------------------------------------------------------------------------- | --------------- |
| Email in the paper | A verified address on the account appears in the paper's first page or source                     | Automatic       |
| ORCID              | ORCID sign-in, and the work appears on that record **from a third-party source** such as Crossref | Automatic       |
| Co-author vouch    | A confirmed author approves the claim                                                             | Automatic       |
| Manual             | Name match, a self-added ORCID work, or an explanation                                            | Moderator queue |

- **A self-added ORCID work isn't proof.** Anyone can add any paper to their own ORCID record, so
  the check has to look at each work's `source`. Confirm those semantics against the ORCID API when
  building this.
- People change institutions. Any confirmed affiliation counts for the email route, and when an old
  mailbox has gone, ORCID or a co-author vouch still works.
- Confirmed co-authors are notified of each new claim and can dispute it, which sends it to the queue.
- **Double-blind review.** Claiming a paper still under anonymous review, such as an ICLR submission,
  would reveal its authors. Claims stay allowed, since arXiv preprints are often public anyway, but the
  claim flow warns about this. A claim can stay private until the author publishes it, but while private
  it grants no edit rights, because acting as the named author would reveal the claim.
- Any confirmed author can edit the section. It displays "maintained by" with their names as listed
  on the paper, never their handles (section 5.3), and history shows who did what.

### Content

A structured header comes from `resources.json` (TL;DR, code, data, demo, video, slides, poster,
BibTeX), followed by free Markdown with media and math. Starter templates make it easy to reach the
standard of a good project page.

To replace those sites, it needs richer content than text, so `author/page.md` can embed media
uploaded to R2 (images and short video, with size limits) and iframes from an **allowlist** of
hosts: YouTube, Hugging Face Spaces and similar. Anything more interactive becomes an extension.

An unclaimed section shows "Are you an author? Claim this page", with links to the community section
below it.

## 7. The community section

- **Open to any verified account**, section by section like Wikipedia, with preview and an edit
  summary. Starter headings: Summary, Why it matters, Critique, Errata, Reproductions, Follow-ups.
- **Conflicts of interest are visible, not banned.** Edits by a paper's confirmed authors appear under
  their author identity with a badge (section 5.3). Authors have no special power here.
- **Anti-vandalism is the real product.** Wikipedia works because patrolling is cheap, so these are
  v1 and not extras:
  - `/changes`, a filterable feed of all edits
  - watchlists with email digest
  - one-click revert
  - per-page protection levels
  - rate limits that are tighter for new accounts
  - reports and account blocks
- **Institutional email is a strong anti-sockpuppet measure**, and also why a block means something.
- **Bots are labeled.** Bot accounts are minted by an operator, marked in every commit, and
  filterable in all feeds. As in acceptodds they are welcome, but never mistaken for people.

## 8. Labeled links

### Format

A link is a statement made **on the source page about the target**. It lives as one line in that
page's `<part>/links.jsonl` (`community/links.jsonl`, `author/links.jsonl`), so it gets history, revert and blame with no extra machinery:

```json
{
  "id": "01JC8Z...",
  "to": "arxiv:1706.03762",
  "label": "extends",
  "note": "Replaces the decoder with ...",
  "from_anchor": "Section 3",
  "to_anchor": "Eq. 2",
  "evidence": "https://..."
}
```

- `to` is a public identifier, never an internal id, so a clone means something on its own: a paper's
  (`arxiv:…`, `doi:…`) or any other kind's (`venue:iclr/2027`, `topic:linear-attention`, `org:eth`, `user:alice`).
- `page_links` is the query index, derived from git and rebuildable. It answers "what links here",
  which is shown on the target page as well as the source.
- `origin` comes from the path: `author/` links show as author-asserted and `community/` links as
  community-asserted. Links where the editor is a confirmed author of either paper use their author
  identity and carry a COI badge, whichever repo the link is stored in.

### Vocabulary

Labels are data, in a table, with a reading in each direction:

| Label                | Reads as           | Inverse           | Group     | CiTO           | Note required |
| -------------------- | ------------------ | ----------------- | --------- | -------------- | ------------- |
| `extends`            | extends            | extended by       | lineage   | `extends`      |               |
| `improves-on`        | improves on        | improved on by    | lineage   |                |               |
| `uses-method`        | uses the method of | method used by    | lineage   | `usesMethodIn` |               |
| `uses-data`          | uses data from     | data used by      | lineage   | `usesDataFrom` |               |
| `surveys`            | surveys            | surveyed by       | lineage   | `reviews`      |               |
| `replicates`         | replicates         | replicated by     | support   | `confirms`     | yes           |
| `supports`           | gives evidence for | supported by      | support   | `supports`     |               |
| `fails-to-replicate` | fails to replicate | not replicated by | contest   | `disputes`     | yes           |
| `contradicts`        | contradicts        | contradicted by   | contest   | `disputes`     | yes           |
| `corrects`           | corrects           | corrected by      | contest   | `corrects`     | yes           |
| `responds-to`        | responds to        | response from     | discourse | `repliesTo`    |               |
| `concurrent-with`    | concurrent with    | (symmetric)       | discourse |                |               |
| `same-idea-as`       | same idea as       | (symmetric)       | discourse |                |               |
| `related`            | related to         | (symmetric)       | discourse |                |               |
| `in-topic`           | is about           | covered by        | topic     |                |               |
| `introduces-topic`   | introduces         | introduced by     | topic     |                |               |

Built 2026-11-16 (`handoffs/pages.md` Phase 1): the vocabulary is `src/lib/labeled-links.ts`, where each label
also says which kinds it goes from and to (the classic labels paper to paper, `related` between any kinds, the
topic labels paper to topic). `page_links` is kept by the `links` outbox consumer (`server/page-links.ts`), not in
the commit's transaction, and the paper page and every other kind show "Links" and "What links here".

- Contested labels **require a note**, because that is where the content is.
- **No `plagiarizes` or `scoops` label.** These allege misconduct against named people, and a
  one-click label is the wrong form for that. Such concerns go to moderators.
- Mapping to [CiTO](https://sparontologies.github.io/cito/) gives an interoperable export.
- Extensions can add namespaced labels later, such as `ext.lean:formalizes`. Check the CiTO mapping
  against the ontology when finalizing this table.

### Signal on top of a link

```
link_stances(link_id, account_id, stance agree|dispute, at, pk(link_id, account_id))
```

Stances are one per person and frequently changed, so they are not git content (principle 3). Each
link also has a discussion thread. Removing a link is an edit like any other: visible and revertible.

### Citations as a starting point

Plain citations imported from OpenAlex or similar sit in a separate `paper_citations` table. They
are machine data, not claims, and aren't in git. They do seed the core interaction: a paper's page
lists its citations with the prompt **"How does this connect?"**, which turns one into a labeled link.

### Surfaces

- The paper page lists links grouped by meaning: _Contested by_, _Replicated by_, _Extends_, and so on.
- A neighbourhood graph around the paper, in `d3-force`, with edges coloured by group.
- `/graph` explores further, using recursive CTEs over `page_links`.
- Inline `[[arxiv:1706.03762]]` in prose renders as a paper reference and counts as an unlabeled
  mention, with a prompt to label it.

**Notifications carry the network effect.** A claimed author is emailed when someone links to their
paper, especially with a contested label, and can reply with an author badge on that thread. "Someone
says your paper failed to replicate" is the strongest reason a researcher has to show up.

## 9. Comments

```
comments(id, paper_id, link_id null, parent_id null, account_id, body, created_at, edited_at, removed_at)
```

Comments are threaded, attached to a paper or a specific link, with `@mentions` and an author badge.
They can be posted anonymously, except on your own paper (section 5.3).
They live in Postgres, not git: they have one writer each, are high volume, and need no merging.
Public dumps include them. Anything that deserves to last gets edited into the page, as with a
Wikipedia talk page.

## 10. Extensions (later, but shaped from day one)

**Goal:** anyone can add a feature with nothing more than a public GitHub repo. A plugin adds panels to any kind of
page (a paper, a venue, a topic, an org, a person: `handoffs/pages.md`), readers find and install the ones they
want, and each reader's site and plugin preferences live in one `settings.json`. Decided with Benedict on
2026-11-16; `handoffs/plugins.md` is the plan and its phases, and where it and this section differ, it wins.

### settings.json

Built 2026-11-16 (`handoffs/plugins.md` Phase 1). One document per account, layered as in VS Code:

- **Layers:** defaults ← site ← user. Defaults come from the core settings (`lib/settings/core.ts`, zod, one
  entry per key with its default and description) and from each installed plugin's `contributes.settings`. The
  site layer is one `site_settings` row, set by admins with `npm run settings:site`, so it changes without a deploy.
  The user layer is the account's `user_settings` row. A signed-out reader's document lives in localStorage and is
  offered for import when they sign in.
- **Keys are dotted** (`paper.panels.hidden`); a plugin's are namespaced by its id
  (`benedict-armstrong/score-standing.view`). The document holds only what differs from the layer below.
- **The text is kept as written** (JSONC, so comments and key order survive) and parsed when read. Values are
  checked when read and never trusted when written: a bad value reads as the layer below, so a hand-edited file
  never breaks a page. `PUT /api/v1/me/settings` takes the file itself and reports every problem, each on a line
  naming its key; unknown keys are kept, with a warning, so a file can name a plugin's settings before the plugin
  is installed. Agents and scripts use the same route.
- `/schemas/settings.json` is its JSON Schema: the core keys and the requesting account's installed plugins' keys.
  `/settings` has a form made from the schema, the raw file with the same checks, and Export and Import.
- **Settings are preferences.** Remembered state (dismissed prompts, a plugin's cache) stays out of the document,
  and so does consent (below).
- The first core keys are `<kind>.panels.hidden` and `<kind>.panels.order`: a reader turns panels off or reorders
  them within their slots (§4.8), built-in ones by id and plugins' as `<plugin id>.<panel id>`. Pages stay the same
  HTML for every reader, so these apply in the browser after load. Then `plugins`, `plugins.default` and
  `plugins.blocked` (below).

### The model

Built 2026-11-16 (`handoffs/plugins.md` Phase 2). A plugin is a public repo (or a folder of one) with a
`potentialpaper-plugin.json` manifest and built files committed to it. We never run a build.

- **The manifest** (`lib/plugins/manifest.ts`, zod; JSON Schema at `/schemas/plugin-manifest.json`) names an `id`
  (`<GitHub owner>/<name>`, and the owner must be the repo's), `name`, `version` (semver), `apiVersion` (1), `main`
  (an HTML file), `permissions` (`page.read`, `scope.read`, `reviews.read`), `network` (https origins its own backend
  lives at) and what it `contributes`: `panels` (`{ id, title, kinds, slot, when? }`; `slot` is `main`, `aside` or
  `tab`, one for every kind or one per kind, `{ "paper": "aside", "*": "main" }`), `pages` (whole pages at
  `/x/<owner>/<name>/<page>`), `settings` (`SettingSpec`s, keyed `<plugin id>.<name>` in settings.json) and
  `commands` (in each of its panels' menus). The validator reports every problem in one pass, each on a line naming
  its field; unknown fields are warnings, so a newer manifest still loads on an older host.
- **`when` conditions** (`lib/plugins/when.ts`), VS Code's clauses cut down: `page.hasScores`,
  `page.kind == venue && signedIn`. Each kind offers its context keys in the kind registry (`KindInfo.contextKeys`:
  `page.kind`, `signedIn`, `viewer.isOwner`, and `page.hasScores`/`page.hasSubmissions` where they mean something). A
  panel whose condition is false starts no frame.
- **Sources** (`lib/plugins/sources.ts`): `github:<owner>/<repo>[/<folder>][@<ref>]`, also typed as `owner/repo` or a
  GitHub link. Installing resolves the ref to a **commit** (git's ref listing, as demos do: no token, no rate limit),
  copies the kept files at that commit once into the demos' store (R2), and pins the ref (`plugin_refs`), so a moving
  branch changes nothing: updates are explicit. Kept are files of the content domain's types (the demos' list, which
  has `png`, `woff2` and `wasm`), outside dot-folders and `node_modules`; at most 500 files, 20 MB, 10 MB each. The
  manifest is checked when the copy is taken (`plugin_snapshots`), and a copy with errors is refused.
- **Installed plugins** (`lib/plugins/installed.ts`) are the site's `plugins.default` and the reader's `plugins`
  key (`{ "<source>": { "enabled": true, "ref": "v1.0.0" } }`). `POST /api/v1/me/plugins` installs by source and edits
  the key, keeping the rest of the file; `GET /api/v1/plugins/installed` lists them for a page, each with the commit it
  runs and its status: `ready`, `consent`, `blocked`, `disabled` or `error`.
- **Dev mode:** a source of `http://localhost:<port>/` (kept in that browser's localStorage, `pp.plugins.dev`) runs
  unpinned from the author's dev server, in their browser only, with what it asks for.

### Security is what shapes everything

Arbitrary JavaScript on the main origin could act as any signed-in user. So:

- **Each plugin runs on its own origin**, `plugin-<hash>.ppusercontent.com/<commit>/…`, where the label is a
  stable hash of the plugin id, on a different site from the app (`server/plugins/serve.ts`, beside the demos'). Its
  frame is `sandbox="allow-scripts allow-same-origin"`: the same-origin flag is safe only because the origin is the
  plugin's own, and it lets a plugin keep its own IndexedDB cache across versions. Its CSP is `default-src 'self'`,
  scripts from itself and the SDK (and `'wasm-unsafe-eval'`), inline styles, `connect-src 'self'` plus the
  manifest's `network` origins, and `frame-ancestors` the site. Files are cached for good: a commit never changes.
- The **only** bridge is a typed, versioned `postMessage` RPC (`lib/plugins/protocol.ts`, Presio's envelopes over a
  `MessagePort`): the frame says hello, the page checks the message's window and origin and answers with a port and
  the context. Each call is checked against the permissions the user granted (`lib/plugins/host.ts`). A plugin never
  touches the host's DOM or session; it declares what it adds, and the host draws it (`components/plugins/`).
  Methods: `context.get` (the page, its scopes, the viewer, the theme), `settings.get`/`set` (own keys only) and a
  `settings.change` event, `storage.get`/`set` (64 KB per account and plugin, in Postgres; localStorage when signed
  out), `page.read`, `page.members`, `page.resolve`, `reviews.forPaper`, `ui.setHeight` and `ui.openUrl`; theme
  tokens are sent at boot and on change. Frames start when scrolled near. The SDK is one file,
  `https://ppusercontent.com/sdk/v1/pp.js`, with `pp.d.ts` beside it; `examples/plugins/hello/` uses it.
- The reads go through public routes anyone can call, `GET /api/v1/pages/<identifier>` and its `/files`, `/members`
  and `/submissions`, so a plugin's own backend reads the same data; they give only what the page shows the public
  (a user page's `about/` and links, §5.3).
- **Consent is not in settings.json.** The document lists installed plugins (the `plugins` key), and a hand-edited
  file can add one, but a grant row (`user_plugin_grants`: plugin id, SHA, permissions, network origins) records
  what was approved. A plugin whose manifest asks for anything its grant lacks shows an approval prompt instead of
  running, listing its permissions and network origins in plain words, so an update that asks for more asks again.
  Only a browser session can approve, never an agent's token. A site default runs with what it asks for: the admin
  who added it approved it.
- **Plugins never write state other users share.** Shared state that clients can write can be poisoned by anyone.
  Data comes three ways: aggregates the site computes per scope (a `scope_stats` consumer, §4.9), generic bulk
  reads of a scope's papers with ETags, and a plugin's own backend (its `network` origins, or a bot, below).
  Per-user plugin storage is fine.
- Writes go through `commitPage` like any others and record the extension in a trailer.

VS Code makes the same trade: extensions get APIs and webviews, not the host's DOM. So "almost
arbitrary" means adding panels, tabs, whole pages, renderers, labels and commands. It doesn't include
restyling the host page or reading its session. That limit is what makes it safe to run strangers' code.

### Trust levels

Each user installs what they want, and it affects only them. Discovery lists public repos with the GitHub topic
`potentialpaper-plugin`. The site layer of settings.json holds `plugins.default` (sources installed for everyone,
which a user can turn off) and `plugins.blocked`, the kill switch (ids, or ids at a SHA). Both are read from the
site layer only (`siteOnly` in `lib/settings/core.ts`): a user's file naming them changes nothing, with a warning.

### Server-side extensions: bots

We host none. An extension backend runs anywhere, reads `GET /api/v1/events` or receives webhooks, and
acts through a bot token that is labeled like any bot.

Decided 2026-11-16: bots are how data gets onto pages, and they work like GitHub Apps:

- **A bot is a registration** with an id, an owner and **write grants on path patterns**, such as
  `reviews/openreview/**`. It starts with none. Admins grant them, by script, and the grant also says
  whether what it writes is shown to everyone by default. Grants are rows, checked by the same path rules
  as everyone (`rules.ts`), and a wider grant needs an admin again. Built 2026-11-16: a bot is an account with `is_bot`,
  its grants are `bot_grants` rows (`npm run bots:grant`), and for now a grant can only be a source's folder,
  `reviews/<source>/**` (`grantProblem`).
- **It commits through the same API** (`commitPage`), one page per commit, with `Bot: true` and its id in
  the trailers, under its own rate limits. Re-running an import that finds nothing new commits nothing.
- **Its tokens are short-lived**, made from a long-lived secret, as GitHub Apps' installation tokens are.
- **It hears about changes** through webhooks from the outbox (§4.9), each with a delivery id so a bot can
  drop repeats, or by reading `GET /api/v1/events`.
- **What it writes must match a file type** (§4.8), so the site can show, index and check it with no code
  of the bot's.

Our own OpenReview import is the first bot, `openreview`, and goes through exactly this route, which keeps
the route honest. The activity feed hides bot commits by default.

### What to do now, so this stays cheap

| Build now                                                                | Why                                                            |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| API first; the UI uses `/api/v1` with OpenAPI                            | The extension API is mostly this                               |
| Event outbox written by every commit                                     | Feeds, webhooks and extensions share it                        |
| Paper page assembled from named slots (`paper.aside`, `paper.tabs`, ...) | Built-in panels become the first extensions                    |
| Fence renderer registry in Markdown                                      | Rendered output has somewhere to attach                        |
| Path permissions, with `extensions/` reserved                            | Extension data has a defined, safe home                        |
| File types with schema, indexer and renderer (§4.8)                      | Renderers from extensions plug in by path                      |
| Bot grants on path patterns, as data                                     | Third-party bots need no code from us                          |
| Labels stored as data                                                    | Namespaced labels need no schema change                        |
| Strict CSP from the start                                                | Retrofitting CSP is painful                                    |
| Built-in panels by stable id (`lib/panels.ts`), arranged by settings     | Plugin panels join the same slots and order (built 2026-11-16) |

## 11. Attribution, licensing, legal

- **Contribution license.** Not decided; see section 12. Contributors must agree to one before they
  edit, or the corpus can't be reused and clone-able repos are legally murky.
- **Takedown process.** The site publishes user claims about named people's work. It needs a notice
  process, moderator tools and terms. Get legal advice before public launch, in particular on
  defamation and EU DSA duties.
- **Privacy.** Commits hold pseudonymous ids only; deleting an account unlinks the handle. Author
  identities keep the name printed on the paper, which is public anyway.

## 12. Decisions and later work

Decided on 2026-11-05:

- **Storage:** git objects in Postgres (section 4).
- **Identity:** real names are optional, with anonymous commenting available (section 5.3).
- **Joining:** institutional email only, following acceptodds (section 5).
- **Name:** PotentialPaper.

Decided on 2026-11-16 (the work is in [handoffs/data-model.md](handoffs/data-model.md)):

- **The repo is the data, plugins are views** (principle 6). Imported submissions and reviews move into
  the page repo under `reviews/<source>/`, written only by that source's bot, so score changes have
  history (§3, §4.3).
- **File types** with schema, indexer and renderer are the contract between bots and plugins (§4.8).
- **Bots work like GitHub Apps:** path grants as data, short-lived tokens, webhooks with delivery ids
  (§10).
- **Derived data outside `page_current` comes from outbox consumers**, idempotent per page and
  rebuildable from zero (§4.9).
- **Search covers every file** through `search_docs` (§4.10).
- **Scaling** goes through five seams, built now; queues, sharding and object storage wait (§4.11).
- **Postgres 19**, from 16 (§4.11).

### Later

- [ ] **Choose the contribution license.** To discuss. The starting proposal is CC BY-SA 4.0 for
      community content and CC BY 4.0 for author sections. **This must be settled before anyone outside
      the team edits**, because relicensing other people's contributions later is close to impossible.
- [ ] **Choose the final domain.** `potentialpaper.com` is the candidate. The extension domain can wait for
      this.
