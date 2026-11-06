# PotentialPaper — design

Status: draft for review, 2026-11-05.
The build order is in [IMPLEMENTATION.md](IMPLEMENTATION.md).

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
   together is in git. Votes, comments and sessions are not.
4. **Git is the source of truth for page content.** Every page-content table in Postgres can be
   rebuilt from it.
5. **The UI is one client of the API**, as in acceptodds. Bots and extensions use the same API.

### Not in the first version

- Hosting PDFs. We link out, which avoids a large copyright problem.
- Formal review scores or reputation systems. An extension can experiment with these first.
- `git push` to a page.
- Real-time co-editing.

## 2. Stack

Same as acceptodds unless a reason is stated here. The reference is
[PotentialHedge/acceptodds](https://github.com/PotentialHedge/acceptodds), checked out locally at
`../papermarket/platform`.

| Concern | Choice                                                                          |
| ------- | ------------------------------------------------------------------------------- |
| App     | TypeScript, Next.js 16 App Router, Node 26, `output: 'standalone'`              |
| Data    | Postgres 16 with Drizzle; migrations are a separate deploy step                 |
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
- **Duplicates get merged.** An admin or moderator sets `merged_into`. The old address redirects,
  and its repo's content is folded into the survivor with one commit that records where it came
  from. Links resolve through the merge when read.

## 4. Each page is a git repo

### 4.1 Decision: real git objects, stored in Postgres

A page's history is a **real git repository**: real blobs, trees and commits with real SHA-1 ids,
and a stock `git clone` works. The objects are rows in Postgres instead of files on disk.

```
page_refs(paper_id pk, head oid)                       -- the only mutable part of a repo
page_objects(paper_id, oid, type, body, pk(paper_id, oid))
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

|                             | Postgres objects           | Bare repos, `git` plumbing                                 |
| --------------------------- | -------------------------- | ---------------------------------------------------------- |
| Write a commit, p50 / p99   | 11 / 37 ms (8 connections) | 160 / 177 ms (serial)                                      |
| Throughput                  | 619 commits/s              | about 6 commits/s                                          |
| Storage, 20-revision page   | 23 KB including indexes    | 655 KB, 164 inodes; 72 KB, 17 inodes after `gc` (one page) |
| Read current page / history | 1.2 / 1.5 ms               | not measured                                               |
| `git clone`, 20 commits     | 334 ms, 85 requests        | not measured                                               |
| `git clone`, 500 commits    | 3.5 s, 2005 requests       | not measured                                               |

Read the write gap with care. The disk column forks 8 `git` processes per commit, and an in-process
library or `git fast-import` would narrow it substantially, so forking explains much of that gap and
storage may explain little. **The deciding argument is atomicity and operational simplicity, not
raw speed.** Expected write rates are far below either figure. The Postgres timings include the
object insert, ref update, revision row, projection and link index, but not Markdown rendering or
merging. Conflict handling was not exercised. Clones were tested on git 2.34.1 over loopback,
without a CDN. Every clone passed `git fsck --full --strict`.

**What this costs.** We own a small piece of git-format code, there are no hooks or native push, and
tools that expect files on disk need a clone first. Nothing is locked in: `git clone` of any page
gives a normal repo.

**Scale check.** At the measured 23 KB per page, one million actively edited pages come to about
23 GB, which one Postgres handles comfortably. The primary key leads with `paper_id`, so hash
partitioning remains available later.

### 4.2 A repo exists only after the first edit

A page nobody has edited is a `papers` row with no objects. Millions of stubs therefore cost almost
nothing, and the first commit creates the repo with a metadata snapshot.

### 4.3 Repo layout, and permissions by path

```
metadata.json            system: identifiers, title, authors, abstract snapshot
author/page.md           the author section
author/resources.json    code, data, demo, video, slides, poster, BibTeX
author/assets.json       uploaded media as pointers: sha256, type, size
author/links.jsonl       links the authors assert
community/page.md        the community section
community/links.jsonl    links the community asserts
extensions/<id>/...      reserved: data owned by one extension (section 10)
```

**Permissions are rules on paths**, checked in one place:

| Path                 | Who may commit                                   |
| -------------------- | ------------------------------------------------ |
| `metadata.json`      | System ingest, admins                            |
| `pdf.json`           | System ingest, admins                            |
| `author/**`          | Confirmed authors of this paper, admins          |
| `community/**`       | Any verified account, subject to page protection |
| `extensions/<id>/**` | Extension `<id>` acting for a consenting user    |

Media doesn't go in git: bytes go to R2, keyed by hash, and git records the pointer, as Git LFS
does. `pdf.json` is such a pointer: the SHA-256, size, URL, source page and license of the
paper's PDF, copied unmodified. Files are one record per line, so links diff cleanly.

### 4.4 The write path

`commitPage(paperId, baseOid, actor, changes, summary)` is the **only** writer of page state, as
`engine.trade()` is in acceptodds. Within one transaction it:

1. Checks path permissions, page protection and rate limits.
2. Validates files, including link syntax, labels and targets.
3. If `baseOid` is not the head, runs a three-way merge per file. A real conflict returns `409` with
   both versions, and the editor shows them.
4. Writes blobs, trees and the commit.
5. Moves the head with compare-and-swap, `UPDATE ... WHERE head = $base`.
6. Updates `page_current`, `page_links`, the search index, `page_revisions` and the event outbox.

After commit it purges the Cloudflare URLs for the page and its link targets.

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
page_current(paper_id pk, head, author_html, community_html, resources jsonb, updated_at)
page_revisions(paper_id, seq, oid, account_id, kind, summary, paths[], bytes_delta, at, pk(paper_id, seq))
page_links(id, source_paper, target_paper, label, origin, note, ..., revision)
```

Markdown is rendered and sanitized **at commit time** and stored as HTML. Raw HTML in Markdown is
never allowed. History pages read `page_revisions`, and diffs are computed in-process from blobs
and cached by oid pair.

### 4.6 Clone access

v1 implements git's **dumb HTTP protocol**, read-only, in one route handler:

```
GET /git/arxiv/1706.03762.git/info/refs
GET /git/arxiv/1706.03762.git/HEAD
GET /git/arxiv/1706.03762.git/objects/ab/cdef...
```

Object responses are immutable, so the CDN can cache them indefinitely. The cost is one request per
object, which is fine for small repos but noisy for long histories. If that matters, add packfile
generation. Push, if ever wanted, means implementing `receive-pack` and running every incoming
commit through the same path rules.

### 4.7 Redaction

Git history is immutable, but libel, doxxing and legal takedowns require removal. Redaction is a
rare admin action that rewrites that one page's commits from the bad one onward, replacing the blob,
and records the old-to-new oid map and the reason in a public log. Existing clones keep the old
history and diverge. Having a repo per page limits the damage to one page, which is a real
advantage of this model.

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
as evidence for author claims. People with no eligible address use the request form below.

Reading never requires an account.

### 5.2 Requesting an institution

A refused address now gets a short form instead of a dead end:

```
institution_requests(id, email, domain, institution_name, website, ror_id null, note,
                     status, reviewed_by, decided_at, created_at)
institution_domains(domain pk, name, added_by, request_id null, created_at)
```

- The form is prefilled with the address and domain. Each request is rate limited, duplicates for a
  domain are grouped, and public suffixes and free-mail domains are refused automatically. Company
  labs can request this way too.
- An admin queue at `/admin/institutions` shows the request with its domain's website and any ROR
  match, then approves or rejects it. The curated file's rule applies: only a domain whose mailboxes
  the organization gives to its own staff.
- Approving mails the requester a sign-up link. The requester's email is deleted from the request
  once it is decided.
- acceptodds reads its allowlist from a file once per process, so a change needs a restart. Here the
  generated domains remain a file, and the **`institution_domains` table overlays it** in the same
  in-process map, refreshed on approval. `institutionForEmail` stays synchronous, so its call sites
  copy across unchanged. This assumes one app process, as acceptodds' caches do.

Roles are `admin` (by env, as acceptodds does it) and `moderator`.

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

| Route              | Evidence                                                                                          | Result                   |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------------------------ |
| Email in the paper | A verified address on the account appears in the paper's first page or source                     | Automatic                |
| ORCID              | ORCID sign-in, and the work appears on that record **from a third-party source** such as Crossref | Automatic                |
| Co-author vouch    | A confirmed author approves the claim                                                             | Automatic                |
| Manual             | Name match, a self-added ORCID work, or an explanation                                            | Admin or moderator queue |

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
page's `links.jsonl`, so it gets history, revert and blame with no extra machinery:

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

- `to` is a public identifier, never an internal id, so a clone means something on its own.
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

**Goal:** anyone can add a feature with nothing more than a public GitHub repo.

### The model

A repo has a manifest and built files at a commit:

```json
{
  "id": "ben.replication-tracker",
  "name": "Replication tracker",
  "version": "0.3.0",
  "entry": "dist/index.html",
  "permissions": ["paper.read", "links.read", "repo.extensionData.write"],
  "contributes": {
    "paperPanels": [{ "title": "Replications", "slot": "paper.aside" }],
    "fenceRenderers": ["replication-table"],
    "linkLabels": [{ "id": "formalizes", "reads": "formalizes", "inverse": "formalized by" }],
    "pages": [{ "path": "/x/replications", "title": "Replications" }]
  }
}
```

Registering means giving us a repo URL. We pin the **commit SHA**, snapshot those files to R2, and
never run a build. Updates are explicit, and new permissions need new consent.

### Security is what shapes everything

Arbitrary JavaScript on the main origin could act as any signed-in user. So:

- Extensions run in **`<iframe sandbox="allow-scripts">`** on a **separate registrable domain** we
  own, with no cookies from the main site and a strict CSP.
- The **only** bridge is a typed `postMessage` RPC, and each call is checked against the permissions
  the user granted.
- Writes go through `commitPage` like any others and record the extension in a trailer.

VS Code makes the same trade: extensions get APIs and webviews, not the host's DOM. So "almost
arbitrary" means adding panels, tabs, whole pages, renderers, labels and commands. It doesn't include
restyling the host page or reading its session. That limit is what makes it safe to run strangers' code.

### Trust levels

Each user installs what they want, and it affects only them. Admins can review specific versions and
make them default for everyone. A kill switch disables any extension site-wide.

### Server-side extensions

We host none. An extension backend runs anywhere, reads `GET /api/v1/events` or receives webhooks, and
acts through a bot token that is labeled like any bot.

### What to do now, so this stays cheap

| Build now                                                                | Why                                         |
| ------------------------------------------------------------------------ | ------------------------------------------- |
| API first; the UI uses `/api/v1` with OpenAPI                            | The extension API is mostly this            |
| Event outbox written by every commit                                     | Feeds, webhooks and extensions share it     |
| Paper page assembled from named slots (`paper.aside`, `paper.tabs`, ...) | Built-in panels become the first extensions |
| Fence renderer registry in Markdown                                      | Rendered output has somewhere to attach     |
| Path permissions, with `extensions/` reserved                            | Extension data has a defined, safe home     |
| Labels stored as data                                                    | Namespaced labels need no schema change     |
| Strict CSP from the start                                                | Retrofitting CSP is painful                 |

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
- **Joining:** institutional email or the request form, following acceptodds (section 5).
- **Name:** PotentialPaper.

### Later

- [ ] **Choose the contribution license.** To discuss. The starting proposal is CC BY-SA 4.0 for
      community content and CC BY 4.0 for author sections. **This must be settled before anyone outside
      the team edits**, because relicensing other people's contributions later is close to impossible.
- [ ] **Choose the final domain.** `potentialpaper.com` is the candidate. The extension domain can wait for
      this.
