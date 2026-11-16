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
- Redaction script and its public log.
- **Blocker for the alpha: choose the contribution license** (design section 12, still to discuss).
- Alpha with a few dozen invited researchers, in one field, on ICLR papers. Most of what matters is
  learned here: do people edit, and does patrolling hold up?

## 4. Labeled links

- `links.jsonl` validation, label table, `page_links`, "add a link" form, backlinks on the target.
- Grouped link display, stances, neighbourhood graph, `/graph`.
- Citation import and the "How does this connect?" prompt.

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
