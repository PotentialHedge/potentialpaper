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
