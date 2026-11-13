# Handoff: the page repo as the thing people edit (files, then push over HTTPS and SSH)

Read `handoff.md` first (stack, deploy, how to work with Benedict), then `DESIGN.md` §4 ("Each page is a git
repo"). Work on branch `repo-files` (branched from `venue-versions`, which isn't merged yet). Commit and push to
`origin repo-files` after each working step; no Claude attribution in commits. Don't merge to `main` and don't deploy.
Pre-launch: breaking changes and data resets are fine. Don't screenshot or preview the UI; Benedict looks himself.

## Goal

The site behaves like GitHub for papers: it displays what is in each paper's git repo, and the repo is laid out so a
person with a text editor can reasonably edit it, then `git push` it back over HTTPS (API token) or SSH (their key).
The bespoke in-place editors go later, replaced by one generic "edit this file" view (**not now**).

## Decisions (made with Benedict, 2026-11-13; don't reopen)

- **Many small files, folders over big files.** JSON is fine for structured data.
- **Content sections are files**, Markdown or HTML, separately for the author part and the community part (e.g.
  `author/<section>.md`, `community/<section>.html`). HTML written by people must be sanitized at commit time
  (allowlist; no scripts, styles or event handlers). Pick an ordering rule a person can see in a file listing.
- **Versions:** a directory, one JSON file per version (replaces `versions.jsonl`).
- **Links:** editable as files too (a directory, one file per link, or similarly simple).
- **System-owned files go in `.potentialpaper/`**, which only the system/admins write (metadata, the PDF pointer, …).
  This means relaxing the "no leading dot" path rule for exactly that one directory name.
- **Demos:** a demo block may name a GitHub URL (`https://github.com/x/y` plus optional ref/path) instead of a snapshot
  id; the server takes the snapshot when the commit comes in. Demos may also live in the repo itself under
  `demos/<name>/` (an `index.html` and its files) and be served from the demo host the same way snapshots are.
- **Pictures and PDFs:** leave as they are (pointers to R2) for now; decide later.
- **Push identity, option (a):** pushed commits are stored verbatim (oids don't change), but only if author and
  committer are exactly the identity the server assigns that account _on that repo_ (`u_…` normally, the per-claim
  `a_…` on a paper they've claimed). Otherwise reject, telling them the `git config user.name/user.email` to set.
  Never accept a real name/email into public history.
- **Push rules:** fast-forward only, no merge commits (say "rebase"), every commit checked by the same path rules and
  content checks as a web edit, evidence via `Evidence:` trailers, same rate limits; projections and cache purge
  afterwards as for a web edit. Errors come back as `remote:` lines.
- **Transports:** smart protocol core in TypeScript over `page_objects` (objects stay in Postgres, no bare repos on
  disk). HTTPS with `pp_live_` tokens as the password; SSH via an `ssh2` server with keys in a new table and a page in
  account settings to add/remove them. SSH needs a DNS-only hostname, port to be decided with Benedict.

## Phases (one agent each; update this file at the end of yours)

1. **Layout.** New repo layout (`.potentialpaper/`, section files, `versions/`, links as files), path rules, content
   checks, projections, renderer, the existing web editors and APIs kept working against it, scripts that write
   pages, and a migration (a system commit per existing page is fine; or reset the dev DB and re-import). Tests.
2. **Demos.** URL demo blocks snapshotted at commit; `demos/<name>/` served from the demo host.
3. **Checks in the commit path.** Everything an API route checks before calling `commitPage` that a raw tree could
   violate moves down, so one function validates any new tree against its parent. A test that builds bad trees
   directly.
4. **Fetch over smart HTTP.** pkt-line, ref advertisement, upload-pack with a packfile writer (no deltas needed).
   Keep or retire dumb HTTP.
5. **Push over smart HTTP.** receive-pack, packfile reader (ofs/ref deltas), the push rules above, token auth.
   Integration test with a real `git` client.
6. **SSH.** `ssh2` server, `ssh_keys` table, settings page, docs for DNS/port; `DESIGN.md` updated (push is no longer
   "not in the first version").

## Log

(Each phase appends: what was built, where, what's left, anything the next phase must know.)

### Phase 1: Layout (done, branch `repo-files`)

**Layout** (`src/server/pages/rules.ts` is the authority; `DESIGN.md` §4.3 updated):

```
.potentialpaper/metadata.json   system, admins
.potentialpaper/pdf.json        system, admins
author/10-tl-dr.md              confirmed authors, admins; one file per section
author/20-results.html          … Markdown or HTML
community/10-summary.md         verified, admins (not the system)
versions/v_k3x9q2ab.json        verified, system, admins; the file name is the id (no "id" field inside)
links/10-code.json              the card: { "label", "url" }; claimed → its authors, else anyone verified
thumbnail.json                  the card: picture pointer (unchanged)
extensions/<id>/…               reserved, refused
```

- **Path rules:** `normalizePath` allows a leading dot only for `.potentialpaper` as the first segment, spelled
  exactly so; everything else is as before. New `layoutProblem(path)` says where nothing may be written:
  sections must be `NN-slug.(md|html)` (two digits, lower-case ASCII slug, so no case or NFC clashes),
  links `NN-slug.json`, versions `<id>.json` with `VERSION_ID` (`[a-z0-9][a-z0-9_-]{0,47}`; ours are `v_…`).
  `commitPage` checks it for every written path (a misplaced file can still be deleted), after `pathDenied`.
  `checkTreeShape` adds counts (≤12 links, ≤50 versions, ≤99 sections a part) and `checkLinkLabels` reads the
  links dir when a link changes, so two link files can't share a label. Old top-level names are refused.
- **Ordering rule:** sections and links show in the order of their file names (byte order = `ls`); new files
  get numbers between their neighbours, in tens; with no room or a move, the part is renumbered.
- **Sections** (`pages/sections.ts`): a section's title is the `#` heading its file starts with (or `<h1>` for
  HTML), else the slug ("why-it-matters" → "Why it matters"). Rendering: each file is section `n` from 1, its
  heading an `<h3 data-section=n>`, other headings two levels down (`markdown.ts` `renderMarkdown(…, { section })`,
  `html.ts` `renderHtmlSection`). So the old page HTML shape is kept and `slots.tsx`/`EditableSection` needed
  no structural change. Editing section `n` = writing its file (`planSections`); new `#` headings typed into a
  Markdown section become new files after it; an emptied section deletes its file. Section 0 (whole part) is
  the files joined (`joinSections`) and is split back at `#`; refused with 422 if the part has an HTML file.
  The editor state now carries `path` and `format`; `/pages/render` takes `format: 'html'`.
- **HTML** (`pages/html.ts`, `sanitize-html` 2.18.1): `htmlProblem` refuses (does not clean) anything off the
  allowlist: other tags, any attribute but title/lang/dir and a few per tag (href, src, alt, colspan…), schemes
  other than http/https/mailto (href) and https (src), `//` addresses. Refusing rather than cleaning is what
  push needs (pushed blobs are stored verbatim). The renderer sanitizes again and adds `rel` to links.
- **Versions / links as files** (`pages/content.ts`): `readVersions`, `versionChanges`, `readLinks`,
  `linkChanges`. `setVersions` now commits per-file changes against `baseOid` and lets `commitPage`'s per-file
  merge do the rest (`mergeVersionLists` is gone). Version files are pretty JSON, a field to a line.
- **Projections:** `writeCurrent` reads the new paths; `author_markdown`/`community_markdown` are now the
  section files joined with headings shifted under the agent page's `##` (`partSource`); `resources` column
  dropped (migration `0020_page_files`); `author/resources.json` is gone (links cover it).
- **Merges** (`merge-papers.ts` `foldPages`): versions and links unioned as files; the duplicate's sections
  become new files after the survivor's, each ending "_From X, merged into this page._".
- **Migration:** `npm run pages:migrate-layout [-- --dry-run]` (`scripts/migrate-page-layout.ts`, pure plan in
  `pages/layout-migration.ts`): one system commit per page, `commitPage(…, { migration: true })` — a system-only
  option that skips path permissions, the change count and the merged-page refusal, but not layout or content
  checks. Old `page.md` splits at `##` with headings moved up a level (`shiftHeadings`), text before the first
  heading becomes `10-introduction.md`. Idempotent. Dev DB: migrated (501 pages, 0 failed) and `pages:rebuild`
  run. **Production:** deploy, `db:migrate`, then `npm run pages:migrate-layout` in the tools container, then
  `scripts/purge-edge-cache.sh`. Until a page is migrated every edit to it fails (no `.potentialpaper/metadata.json`),
  so run it straight after the deploy.
- Removed `scripts/move-demos-into-markdown.ts` (a one-off for the layout before this one).
- Tests: `tests/unit/page-layout.test.ts` (rules, HTML, planning, migration) plus the existing suites updated.
  The 6 `pdf-ingest` integration failures are pre-existing (no poppler on the host).

**Left undone / for later phases**

- Old commits keep the old layout; reverting one from before the migration fails layout checks (fine pre-launch).
- No "edit this file" view yet; section 0 can't include HTML sections.
- Non-ASCII slugs are refused on purpose; titles can be anything (they come from the heading).

**Phase 2 must know**

- Demo blocks still live in Markdown section files only; `writeCurrent` collects `demoIds` from every
  Markdown section, and `editSection` calls `checkedDemoSources` on the edited text (skipped for HTML sections).
  A URL demo block snapshotted at commit belongs in `commitPage`'s path (it must also cover pushed Markdown).
- `demos/<name>/…` needs a branch in `layoutProblem` and `pathDenied` (`rules.ts`); `MAX_DEPTH` is 8 and
  `MAX_FILES` 1000, which a demo folder may hit. Demo files may be binary; `contentProblem` refuses `\0` and
  non-UTF-8 today, so decide what `demos/` allows there.

**Phase 3 must know**

- Checks still done before `commitPage`: `checkedDemoSources` (unknown snapshot), `setLinks` (label rules,
  also enforced in commit now), version `resolve` (PDF lookup), `setThumbnail` (image bytes). Content and
  layout of every file are already checked inside `commitPage`.

### Phase 2: Demos (done, branch `repo-files`)

**Block syntax** (`lib/demos.ts` `parseDemoInfo`, DESIGN.md §4.3): ` ```demo <name> `, title on the first line,
description after. `<name>` is one of

- a GitHub address as GitHub prints it: `https://github.com/<owner>/<repo>[/tree/<ref>/<folder>]`, `/blob/…/index.html`,
  or a gist (resolution is the existing `snapshot.ts`: longest matching branch/tag, or a 40-hex commit; with no folder,
  the first of `''`, `dist`, `build`, `docs`, … with an `index.html`);
- `demos/<name>` (optional trailing slash), a folder of the page's own repo;
- a 32-hex snapshot id (what the editor's "Insert a demo" still writes).

A fence starting `demo` that names none of these is refused in a written section (`demoBlockProblems`), and renders as
code if it is already there.

**URL demos.** The file keeps the address as written; nothing rewrites a committed file. `commitPage` calls
`snapshotNewDemoUrls` (`server/demos/attach.ts`) **before** its transaction (it's a download): addresses in the written
Markdown sections that aren't anywhere in the head's Markdown are copied with `snapshotDemo` (≤5 per commit). A failure
refuses the commit as `the demo at <url>: <GitHub's reason>` (422, or 502 if GitHub is down). Inside the transaction,
`checkDemos` recomputes the addresses new to the page from the final tree and returns them; after `moveHead`,
`pinDemos` upserts `demo_pins (paper_id, url) → snapshot_id, commit` (migration `0021_demo_pins`; not a projection,
`pages:rebuild` reads it). A pin holds while the address is on the page, so later edits never move a branch's demo;
removing the block and adding it in a later commit copies it again (also what a revert of a removal does). An address
new to the page with no copy (the head changed between copy and lock) is `503 page_busy`, retry.

**Repo demos.** `demos/<name>/<path>`: name a lower-case slug (as section slugs), files text only with an allowlisted
extension (`.html .htm .js .mjs .css .json .map .webmanifest .svg .txt .md .csv .tsv .xml .glsl .wgsl .vert .frag .obj
.gltf`), valid UTF-8 without NUL (same as every page file), ≤1 MB each, ≤300 files and ≤5 MB across all of a page's
demos, every folder needs `index.html`. `MAX_CHANGES` (50) no longer counts demo paths; a commit may change ≤300 demo
files. Not sanitized: it's the demo's own code, run only in the sandboxed frame. **Binary assets: not now** — the commit
path is string-only, binary blobs would grow Postgres history, and a demo with images/models/wasm can come from GitHub
(whose copies go to R2). Pictures in a repo demo go in as SVG.
Serving: `writeCurrent` → `pageDemoSources` → `pageDemoSnapshot` (`server/demos/repo.ts`) turns each folder a block
names into an ordinary `demo_snapshots` row (`source = 'page:<paperId>'`, `commit` = the page commit that first had
those exact files, `root = 'demos/<name>'`), its files copied from `page_objects` to the blob store. The id is a hash of
page, folder and git blob ids, so it is known without reading bytes and only a changed folder is copied (in the
transaction, under the page lock; ≤5 MB). Served by the unchanged `serve.ts` at `/d/<id>/`, same headers and sandbox;
the caption says "demos/<name> in this page's repo" with no link. The demo-host TODO stands.

**Who writes `demos/`:** `pathDenied` treats it like `community/` (any verified account and admins, not the system).
`checkDemos` adds: a folder named by a block in the author section (at the head or in the new tree) may only be changed
by confirmed authors and admins (403). Also: a block may only name a folder that exists with `index.html`, so a commit
can't delete a folder a block still names; a written section's snapshot ids must exist (moved down from `editSection`,
same 422 and `details.missing`).

**Other:** `/pages/edit` has `maxDuration = 120`. The preview (`/pages/render`) resolves snapshot ids only and shows an
address or folder as a "copied when saved"/"from this page's demos/x" placeholder. Editor help text mentions both
forms. Tests: `tests/unit/demos.test.ts` (parsing, rendering), `tests/unit/page-layout.test.ts` (paths),
`tests/integration/demos.test.ts` (copy at commit, pin survives a GitHub outage and a rebuild, failed copy refused,
repo demo served and re-snapshotted on change, refusals, author-only folders).

**Left undone**

- No way to write `demos/` from the web; it needs push (phase 5) or a future "edit this file" view. Today only
  `commitPage` callers (tests, scripts) can.
- The editor's "Insert a demo" still inserts a snapshot id (it already copied the files; inserting the address would
  copy twice and might see a moved branch). Could switch to inserting the address later.
- `merge-papers.ts` `foldPages` doesn't carry a duplicate's `demos/` folders; a merged section naming one would be
  refused. No page has one yet.
- Snapshotting happens before the permission check (it's outside the transaction), so a commit that will be refused
  for permissions may still download its demos. Cheap to fix in phase 3 by checking roles first.
- Old blob-store files of replaced repo-demo versions are never deleted (as for GitHub copies).

**Phase 3 must know**

- Demo checks are already in the commit path (`checkDemos`, called after `checkTreeShape` and `checkLinkLabels`);
  `editSection` no longer checks demos. `checkDemos` needs `roles`, the head and final trees, a text reader, the
  pre-transaction `snapshots` map and the sizes of new blobs.
- The only demo step outside the transaction is `snapshotNewDemoUrls`; a tree validator for push must keep it before
  the lock, then let `checkDemos` match.

**Phase 5 must know**

- Pushed Markdown with GitHub addresses gets copied at receive time like a web edit; a multi-commit push should copy
  per commit (pins record the commit that added the address) or at least once per new address.
- Pushed demo files arrive as bytes: refuse non-UTF-8 / NUL (binary) blobs under `demos/` with a clear `remote:` line
  saying binary demo assets must come from GitHub.
