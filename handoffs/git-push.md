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

### Phase 3: Checks in the commit path (done, branch `repo-files`)

**One validator.** `checkTree(db, { paperId, roles, before, after, text, newBlobBytes, migration? })` in
`src/server/pages/check.ts` decides whether the tree `after` may follow `before` for these roles, and returns the
GitHub demo addresses new to the page (to copy, then pin). In order: change counts (`checkChangeCount`); per changed
path its NFC/safe form, `pathDenied` and `layoutProblem` (`checkPath`), then content (`contentProblem`, `null` text =
not UTF-8, with the "binary demo files come from GitHub" wording under `demos/`); then the tree: shape and limits,
link labels, **version PDFs** (a new or changed `pdf` must match `versionPdfAt(url)`'s sha256 and size: uploaded or
copied here), **the picture** (a changed image must sit at `imageAddresses(sha, type)`, where `storeImage` puts it,
`src/server/media.ts`), and `checkDemos`. The system skips the PDF and picture checks. Also in `check.ts`: `Actor`,
`rolesOf`, `authorIdOf` (system / `a_…` / `u_…`), `takeCommit` (rate limit), `checkPaper` (exists, not merged),
`checkEvidence`, `checkMayWrite` (used by `setThumbnail` before storing an upload).

**Web edits.** `commitPage` (`commit.ts`) keeps only edit-specific work: normalizing the change list, the per-file
merge against `baseOid`, the first commit's metadata. Order now: rate limit → roles + `checkPaper` + `checkPath` (with
content) on the requested changes → `newDemoUrls` + `copyDemos` (downloads last) → transaction: roles again, lock,
merge, `checkTree` on the merged tree (the metadata of a first commit counts as already there, so an account's first
edit isn't refused for `.potentialpaper/`) → `recordCommit` → `writeCurrent`. `recordCommit(tx, paperId, commitObject,
commit, otherObjects, pins)` is shared with pushes: objects, CAS head move from `commit.parent`, pins, revision row,
event (payload from the commit itself). `snapshotNewDemoUrls` became `newDemoUrls` + `copyDemos`; `checkDemos`
returns addresses and `pinsFor(added, snapshots)` makes pins (503 `page_busy` if one is missing).

**Pushes.** `src/server/pages/receive.ts`:

```ts
receiveCommits(paperId, actor /* { kind: 'account', accountId, isAdmin } */,
  { old, new } /* receive-pack's old/new ids */, objects: Map<oid, { type: 'blob'|'tree'|'commit', body: Buffer }>,
  { database?, rateLimit?, now? }): Promise<
  | { status: 'unchanged', oid }
  | { status: 'committed', oid, commits: { oid, seq, paths }[] }>
gitIdentity(paperId, actor, database?): Promise<{ id, name, email, commands: string[] }>
```

Contract: `objects` are the packfile's objects, deltas already resolved, keyed by oid (re-hashed and refused if they
don't match); objects not in the pack are read from `page_objects`. All or nothing for one ref update: walks
`new` back to the head (≤ `MAX_PUSH_COMMITS` = 50, one parent each), `old` must equal the head (else 409
`fetch_first`); a merge is refused ("rebase"), a commit on an older commit or a root is 409 `not_fast_forward`; a page
with no repo yet is refused. Per commit: body is UTF-8; headers only tree/parent/author/committer/encoding(UTF-8),
`gpgsig` refused with how to turn signing off; author **and** committer name = id, email = `<id>@users.invalid` for
`authorIdOf` on this page (else 422 `wrong_identity`, message with both `git config` commands and the amend/rebase
command, `details.identity`); committer date ≤ now + 10 min; summary (first paragraph) passes `cleanSummary`
unchanged; no message line with `<x@y>`; trailers (last paragraph, git's rule, `parseMessage`) only `Evidence`
(`cleanEvidence`, no repeats), `Edit-Kind` (+ `Reverts: <commit of this page>` together), `Bot: true` iff the account
is a bot; tree exactly what `buildTrees` makes of its files (only modes 100644/40000; executable, symlink, submodule
and empty folders refused by name), then `checkTree` against its parent. Roles, rate limit (one token per commit) and
every check run before `copyDemos`; then one transaction re-reads roles, locks, checks the head again and that the
identity is the same, re-runs the checks, and `recordCommit`s each commit in order; `writeCurrent` once at the end.
Errors are `ApiError`s whose message is meant to be shown as is (one `remote:` line or a few), prefixed
`commit <7 hex>:` with `details.commit` when one commit is at fault. New codes in `api/errors.ts`: `fetch_first`,
`not_fast_forward`, `wrong_identity`. The caller purges/refreshes the paper's pages (`refreshPaperPages`) as routes do.

**Parsing.** `git-objects.ts`: `parseCommitObject` (tree, parents, author/committer signatures with any time zone,
header names, encoding, message), `parseMessage` (summary = first paragraph on one line; trailers = last paragraph only
if every line is `Key: value`), `parseCommit` builds on them: a commit with no `Edit-Kind` is an edit, `at` is the
committer time (same as before for the site's own commits; a rebase keeps an old author date). `identityEmail(id)`.

**Revert.** `revertCommit` refuses (422, naming the path, "edit the page instead") when the commit changed any path
with a `layoutProblem`, i.e. anything from before the file layout, or the migration commit itself. Cheaper than
translating old layouts, and the text is still in history/diff.

**Tests:** `tests/integration/receive.test.ts`: 19 bad trees pushed by hand, each refused with its message and the head
unmoved (permissions, layout, dot files, HTML, links, labels, version PDF, picture address, demo id/folder/binary, NUL,
NFD name, >50 files, metadata deletion), modes and an empty folder, a merged paper, `checkTree` on bare maps; verbatim
push (oid and bytes unchanged, revision/event/projection/evidence), several commits, `a_…` identity on a claimed paper
and the `u_…` refused there, wrong identities, merge/stale/not-fast-forward/root, message rules, bot trailer, a pushed
revert, a commit made by stock `git` in a real clone; web path: no GitHub fetch before a 403/422 (web and push),
version PDF check, revert of a pre-layout commit. Existing thumbnail fixture now uses `/thumbnails/<sha>.gif`.

**Left / for phase 4–5**

- Phase 5 only needs: pkt-line + receive-pack, packfile reader → `Map<oid, {type, body}>`, token auth → `Actor`, then
  `receiveCommits` per updated ref (only `refs/heads/main`; refuse other refs and deletes in the transport), turning
  `err.message` into `remote:` lines and `ng refs/heads/main <short reason>`, then `refreshPaperPages`.
- `gitIdentity` creates the account's `u_…` on first call (a private row); show it on the clone instructions / a
  settings page, and in every `wrong_identity` refusal (already in the message).
- A pushed GitHub demo is copied once per address for the whole push (one map), pinned to the commit that added it.
- Not checked for pushed commits: the message body's other text (no names policed beyond `<x@y>` lines), author
  date (any). Page protection and new-account limits still don't exist anywhere.
- `merge-papers.ts` and scripts still call `commitPage` and so get all checks; `migration: true` still skips
  permissions and counts only.

### Phase 4: Fetch over smart HTTP (done, branch `repo-files`)

**Built.** `git clone`/`git fetch` over git's smart HTTP protocol, in TypeScript over `page_objects` (no repos on disk,
no `git` on the server). Protocol **v2** (`ls-refs`, `fetch`; git's default, and what 2.34 sends) and **v0/v1**
(`multi_ack_detailed`, `side-band-64k`, `no-progress`, `symref=HEAD:refs/heads/main`). The dumb protocol is kept
unchanged (a GET of `info/refs` without `?service=`, `HEAD`, loose objects; `GIT_SMART_HTTP=0` still clones, and the
edge still caches objects). `?service=git-receive-pack` and `POST …/git-receive-pack` answer **403** text/plain
"Pushing to a page over HTTPS is not available yet." (git prints it as `remote:`); other services 403.
DESIGN.md §4.6 rewritten, measurements added to the §4.1 table.

**Refused cleanly / not built:** shallow (`--depth`, `deepen*`; not advertised, so git itself stops with "Server does
not support shallow requests"; a hand-sent `deepen` gets `ERR … shallow clones are not supported`), `--filter` (not
advertised, git warns and clones whole; a hand-sent one gets `ERR`), tags/`include-tag` (there are none), deltas
(packs carry whole objects), progress messages, `wait-for-done`, `packfile-uris`, `sideband-all`, `no-done`, SHA-256.

**Modules** (`src/server/git/`):

```
pkt-line.ts     pkt(), pktLines(), FLUSH/DELIM/RESPONSE_END, sideband(band, bytes), PktReader (any byte stream), PktError
pack.ts         packHeader, packObjectHeader, packEntry, writePack(count, objects) → AsyncGenerator<Buffer>, packBuffer
repo.ts         GitRepo { head(), commits(), read(oids) }; pageRepo(db, paperId) (Postgres), memoryRepo(head, map)
walk.ts         loadCommitGraph, ancestors, commonCommits, checkWants, objectsToSend, readObjects, FetchError, caps
upload-pack.ts  protocolVersion, advertisement, uploadPackRequest (stateless), uploadPackSession (stream)
http.ts         gitGet / gitPost: the route's adapter (smart + dumb, headers, gzip bodies, streaming)
```

`server/pages/clone.ts` keeps the dumb answers and now exports `parseGitAddress(pathname)` (also matches
`git-upload-pack`/`git-receive-pack`) and `findRepo(address)` → `{ repo, paperId, head } | redirect | missing`
(canonical address, merged papers, no repo yet), which receive-pack should reuse. The route
(`app/git/[...path]/route.ts`) is two lines (`GET` → `gitGet`, `POST` → `gitPost`), `maxDuration = 120`.

**The transport-independent API (phases 5 and 6 reuse this):**

```ts
// Input is any byte stream (an SSH channel, a request body) or one buffer; output is pulled chunk by chunk.
new PktReader(input: AsyncIterable<Uint8Array> | Uint8Array)   // .read(): Pkt | null, .readSection()
protocolVersion(gitProtocol: string | null): 0 | 1 | 2        // Git-Protocol header or GIT_PROTOCOL env
advertisement(repo: GitRepo, version): Promise<Buffer>        // HTTP adds `# service=…` + flush for v0/v1
uploadPackRequest(repo, reader, version): AsyncGenerator<Buffer>  // one stateless request (an HTTP POST)
uploadPackSession(repo, reader, version): AsyncGenerator<Buffer>  // advertisement, then the whole session
pageRepo(database, paperId): GitRepo
```

SSH (phase 6): on `exec git-upload-pack '<path>'`, `parseGitAddress`-style lookup of the path → `findRepo` →
`for await (chunk of uploadPackSession(pageRepo(db, paperId), new PktReader(channel), protocolVersion(env
GIT_PROTOCOL))) channel.write(chunk)` with backpressure, then end the channel (exit status 0). This exact loop is
tested with real git over `git://` in `tests/unit/git-protocol.test.ts` (v2 and v0, clone + fetch + `fsck --strict`),
since `git://` carries the same stateful session SSH will. The generator writes `ERR …` (or band 3 during a pack) on
refusals; it rethrows internal faults after telling the client, so log them.

Push (phase 5): put `pack-reader.ts` beside `pack.ts` (reuse `PACK_TYPE_CODES`; inverse of `packObjectHeader`), and
`receive-pack.ts` beside `upload-pack.ts` with the same shape (`receivePackAdvertisement(repo)`,
`receivePackRequest(repo, reader, actor)` / a session), using `pkt`/`sideband` for `report-status` and `remote:`
lines (band 2). `http.ts` has the 403 placeholders to replace (`PUSH_REFUSED` in `gitGet` and `gitPost`), and its
`readBody` (4 MB cap, gzip) must get a larger cap or stream into the pack reader for push.

**Fetch logic.** `objectsToSend`: all commit rows of the page are read in keyset pages of 2,000 (bodies parsed only
for `tree`/`parent` lines; ≤100,000 commits), the walk runs in memory; uninteresting = ancestors of the common haves;
trees are compared only at the edge (common parents of sent commits), read breadth-first in batches of 500; blobs are
named by their trees and never read until the pack is written, 64 per query, deflated and streamed (≤200,000 objects,
else `ERR`). Wants must be reachable from the head (an older head is fine: the head can move between ls-refs and
fetch). v2: no `done` and nothing in common → `NAK` + flush (client sends more haves); anything common → `ACK`s,
`ready`, the pack. v0 mirrors `upload-pack.c`'s `get_common_commits` for `multi_ack_detailed` and plain clients,
stateless (HTTP) or not (stream).

**Caching / edge.** Checked: the Cloudflare cache rule matches only `/git/…` paths containing `.git/objects/`;
`info/refs?service=` and `git-upload-pack` answers are `Cache-Control: no-store, no-transform` (also stops Next's
gzip from recompressing packs; Cloudflare never caches POSTs). `proxy.ts` needed no change (`/git/` isn't a paper
path). Rate limits unchanged: Traefik's `/git/` router (200/s, burst 1500).

**Measured** (in-process route, dev Postgres, git 2.34.1, summary file 9 KB changed every commit, best of 3):

| page        | smart v2 clone     | smart v0 clone     | dumb clone            | fetch 1 new commit (smart / dumb) |
| ----------- | ------------------ | ------------------ | --------------------- | --------------------------------- |
| 20 commits  | 91 ms, 3 requests  | 133 ms, 2 requests | 202 ms, 94 requests   | 62 ms, 3 req / 123 ms, 6 req      |
| 500 commits | 585 ms, 3 requests | 475 ms, 2 requests | 1.94 s, 2062 requests | 149 ms, 3 req / 55 ms, 6 req      |

A smart fetch reads all commit rows and walks the edge tree, so for one new commit it is slower than dumb's six
cached-object requests; still one round trip and well under the edge timeout.

**Tests.** `tests/unit/git-protocol.test.ts`: pkt-line round trips cut at random (fast-check), malformed input,
side-band cutting; pack headers; packs checked by `git index-pack --strict` + `cat-file` (sizes 0…300 KB, binary,
empty pack); v2 ls-refs (symrefs, prefixes), clone pack = every object, fetch pack = only new objects (count
checked), NAK round, `not our ref`, deepen/filter refused; real `git clone`/`git fetch`/`--depth` over `git://`
against `uploadPackSession` (v2, v0). `tests/integration/page-store.test.ts` (`git clone`): the existing clones now
go smart; new: smart clone + fetch after a new commit for v2, v1 and v0 (no object GETs, `fsck --full --strict`,
`--depth` refused), dumb clone with `GIT_SMART_HTTP=0`, headers of the smart answers, ls-refs by POST, 405/415/403s,
and `git push` showing the not-yet message.

**Left**

- Push (phase 5) and SSH (phase 6), as above.
- Phase 5 must know: `proxy.ts` runs on every path (no matcher, because of the demo host), and Next buffers a
  request body for the proxy up to `experimental.proxyClientMaxBodySize` (default 10 MB, larger bodies are cut off
  with a warning). A push pack can exceed that: raise it, or give `proxy.ts` a matcher that skips `/git/` on the app
  host. Cloudflare's request body limit (100 MB on Free) also applies.
- No per-page cost limit on smart fetches beyond Traefik's request rate; a smart request costs far more than a dumb
  one (all commit rows + tree walk). Fine at current sizes; a DB-backed bucket per IP (like `takeCommit`) if needed.
- Progress messages (band 2) aren't sent; a big clone is silent until done.
- Packs have no deltas; a long-lived page's clone is roughly the sum of its file versions, deflated.
- The compose comment about the git router's limit still describes dumb clones (still true for the fallback).
