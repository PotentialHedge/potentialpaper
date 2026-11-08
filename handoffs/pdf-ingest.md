# Handoff: a PDF ingest pipeline, and claims by an email on the first page

Read `handoff.md` first (stack, deploy, how to work with Benedict), then `DESIGN.md` §6 "Claiming
authorship". This is the next piece of Milestone 5.

## Goal

1. **One pipeline for every PDF we host**, now and as new ones arrive, that reliably does each thing we
   need from a PDF and can be re-run safely. Today that work is scattered over one-off scripts.
2. **First use: the emails on each PDF's first page**, extracted for all PDFs we already host.
3. **Claims by email.** An account with a confirmed address that appears on a paper's first page can claim
   the paper, and the claim is confirmed at once (DESIGN.md's "Email in the paper" route).

**Not in scope, but next:** co-author vouching. A confirmed author approves another person's claim, so
authors whose address isn't on the paper ("they can add others") get in. Leave room for it (see
`method` below), but don't build it.

## What exists

- PDFs are bytes in R2 under their SHA-256 (`pdf/<sha256>.pdf`, public at `PDF_BASE_URL`,
  `https://pdfs.potentialhedge.com`). A page's `pdf.json` points at them (`PdfPointer` in
  `src/server/pages/rules.ts`), projected to `page_current.pdf`.
- `scripts/upload-pdfs.ts` copies a scrape's PDFs to R2 and writes a manifest; `scripts/attach-pdfs.ts`
  commits `pdf.json` for each; `scripts/render-covers.ts` renders page 1 with poppler's `pdftoppm` into
  `pdf_covers` (keyed by sha256). Read these: they have the R2, retry and worker patterns to reuse, and
  the trick of reading PDFs from local disk with a fallback to downloading.
- About 42k ICLR 2027 PDFs in production; the dev database has 500. The original scrape was under
  `../papermarket/research/data/` but isn't there now, so download from R2 unless you find it.
- Poppler (`pdftotext`, `pdftoppm`) is on this Mac via Homebrew. Check whether the production image
  (`Dockerfile`) has it before relying on it in the server.
- Claims: `author_claims` (`src/db/schema.ts`), `src/server/claims.ts`, `/claim/<paper>`,
  `POST /api/v1/claims`, `npm run claims:decide`. Today every claim is pending until an admin decides.
  Confirmed authors get a per-claim `a_` commit identity (`src/server/pages/commit.ts`, `rolesOf`).
- Accounts' confirmed addresses: `affiliations` (`email`, `verified_at`, unique per verified email) and
  the sign-up address in Better Auth's `user` table.

## Suggested design (change it if you find better)

**A `pdf_documents` table**, keyed by `sha256`, one row per distinct PDF, not per paper. It records each
stage's result and the version of the code that produced it, so a run only redoes what is missing or
out of date:

- `pages`, `bytes`, `first_page_text`, and `emails` (normalized, lowercased, deduplicated),
- per stage: `<stage>_version`, `<stage>_at`, and an error with an attempt count, so a broken PDF is
  retried a few times and then left alone.

Fold the existing cover rendering in as a stage, keeping `pdf_covers` or merging it into this table.

**One runner**, e.g. `npm run pdfs:ingest`. It finds every sha256 in `page_current.pdf` whose stages are
missing or out of date, and runs them with a worker pool. It can be stopped and run again, and has
`--stage` and `--sha` for one-off reruns. A new `pdf.json` should get processed without anyone
remembering to run it: a cron on the server, or a lightweight queue (`page_events` already has a row per
commit). Decide which, and write it down.

**Extracting emails from page 1** is the part to get right; write unit tests from real first pages.
Use `pdftotext -f 1 -l 1`, in both raw and layout modes. Watch for:

- grouped addresses: `{alice, bob}@ethz.ch` and `{alice,bob}@inf.ethz.ch`, also with `|` or `;`,
- line breaks inside an address, footnote markers (`alice@ethz.ch*`, `†`), and ligatures or odd
  Unicode from the PDF's fonts (NFKC-normalize, strip zero-width characters),
- `firstname.lastname@` templates and obvious placeholders (`email@domain.com`, `anonymous@`): drop them,
- ICLR 2027 submissions still under review are anonymous, so most have no emails. That is expected, and a
  camera-ready version will be a new sha256.

Measure it: report how many PDFs gave at least one email, and check a sample by hand.

**Privacy.** Emails from PDFs are personal data. Keep them in this private table, never in a page repo,
`page_current` or any public response, and never show which address matched.

**Claims by email.** Add a `method` column to `author_claims` (`manual`, `email`, later `vouch`) and
record the evidence (which address, which sha256) in a private column. Then:

- On `POST /api/v1/claims`, if one of the account's confirmed addresses (affiliations or the sign-up
  address) is among the paper's current PDF's first-page emails, confirm at once with `method: 'email'`.
  The claimant still picks which printed author they are, since an address alone doesn't say which. The
  `author_claims_confirmed_author_key` index already stops two people confirming as the same author.
- Re-check pending claims when an address is verified, and when ingest finds new emails for a paper.
- On the claim page, say that an address on the paper confirms the claim straight away, and which of
  the viewer's addresses would work, without listing the PDF's emails.
- Keep `claims:decide` for everything else.

## Done when

- `pdfs:ingest` has processed every PDF in the dev database, and in production once deployed.
- The email extractor has unit tests from real first pages, and its hit rate is in your report.
- A claim from an address on the first page is confirmed at once; integration tests cover that, a
  claim without a match staying pending, and that no endpoint or page reveals the extracted emails.
- `npm run lint && npm run format:check && npm run typecheck && npm run test:all` pass.
  `tests/unit/page-git.test.ts`'s "does not depend on which side is ours" is a known flaky property
  test of the merge code; it isn't yours to fix.
- `handoff.md` is updated (a "PDF ingest" bullet under Current state), and this file says what was built
  and what changed from the plan.
- It's committed, merged into `main`, pushed and deployed (DEPLOY.md), with migrations applied and the
  production ingest started. Deploying needs Tailscale; if `ssh ben-docker-1` times out, Tailscale on
  this Mac is down, so say so and stop at the push.

## Also not yet deployed

Commit `03331f3` (demos inside Markdown, an editable picture and links, author claims) is pushed but not
deployed, because Tailscale was down. Deploy it with your work: run migrations 0011 and 0012, then once
`npx tsx scripts/move-demos-into-markdown.ts --as <admin handle>` (the admin is the account of
`benedict.armstrong@inf.ethz.ch`), then `scripts/purge-edge-cache.sh`.

## What was built (2026-11-08)

- **`pdf_documents`** (migrations 0013–0015), one row per sha256: `bytes`, `pages`, `first_page_raw`,
  `first_page_layout`, `emails`, `cover_url`, and `stages`, a jsonb map from stage name to
  `{ version, at }` or `{ error, failedVersion, attempts, retryAt }`. `pdf_covers` is merged in: 0014 copies
  its rows as the `cover` stage at version 1, 0015 drops it, and search and the paper page read `cover_url`.
- **`npm run pdfs:ingest`** (`src/server/pdfs/ingest.ts`, CLI `scripts/ingest-pdfs.ts`). Stages `text` (pdfinfo,
  pdftotext raw and layout of page 1), `emails` (reads the stored text, so a new extractor version needs no
  download) and `cover`. Each pass adds a row for every new sha256 in `page_current.pdf`, then runs the stages
  that are missing, out of date, or failed and due for a retry (10 min, 40 min, ~3 h; four attempts per
  version, then left alone). A stage that reads another waits until that one is current. Downloads are
  checked against the sha256. `--stage` (repeatable), `--force`, `--sha` (one PDF, every stage, whatever its
  state), `--dir` (`<sha256>.pdf` files to read before downloading), `--workers`, `--watch`.
  `scripts/render-covers.ts` is gone.
- **New PDFs** are picked up by **polling**, not a queue: the `ingest` service in `docker-compose.prod.yml`
  (tools image, which now installs `poppler-utils`) runs `--watch`, a pass every minute. A pass over ~42k rows
  with nothing due is one indexed scan; a queue would need every writer of `pdf.json` to feed it.
- **Extractor** (`src/server/pdfs/emails.ts`, tests in `tests/unit/pdf-emails.test.ts` with excerpts of real
  arXiv first pages in `tests/unit/fixtures/first-pages/`): groups in `{}`, `[]` or `()` split by `,` `;` `|`,
  across lines; addresses broken over lines in raw mode (not layout, whose next line may be another column);
  footnote markers; NFKC and zero-width characters; templates and placeholders dropped; a domain needs a known
  TLD (any two-letter one, or a listed generic one), which is what rules out `pass@1` and `NDCG@10.The`.
- **Hit rate:** dev database, 0 of 500 (all anonymous ICLR 2027 submissions; only `pass@k`-style tokens). On
  168 recent arXiv first pages (cs.LG, cs.CV, cs.CL, cs.RO), 116 (69%) gave at least one address. Checked by
  hand: all 52 misses print no address (one prints only `{firstname.lastname}@…`, correctly dropped), and none of the
  addresses found looked wrong.
- **Claims:** `author_claims.method` (`manual`, `email`, `vouch`) and private `verification`
  (`{ email, sha256 }`). `requestClaim` confirms at once on a match; `recheckPendingClaims` runs after an
  affiliation is confirmed and after the emails stage finds new addresses; an admin's decision sets `manual`.
  The claim page says which of the viewer's own addresses are on the paper, and drops the evidence box when
  one is. Integration tests in `tests/integration/pdf-ingest.test.ts` (ingest on a generated PDF, retries, a
  match confirmed at once, no match pending, rechecks, and no endpoint, `page_current` or repo object holding
  the extracted addresses). CI installs poppler.

### Changed from the plan

- Stage state is one jsonb map rather than `<stage>_version` / `_at` / error columns, so adding a stage is one
  entry in `STAGES` plus its own columns.
- Text and emails are separate stages, so re-extracting emails never downloads PDFs again.
- The sign-up address counts through Better Auth's `user.email` (when `email_verified`) as well as its
  primary affiliation.

### Not done yet

- **Production ingest has not run:** Tailscale on the Mac was down (`ssh ben-docker-1` timed out), so this and
  `03331f3` are pushed but not deployed. Deploy per `DEPLOY.md`: migrations 0011–0015, then
  `npx tsx scripts/move-demos-into-markdown.ts --as <admin handle>`, then `dc --profile tools up -d ingest`,
  then `scripts/purge-edge-cache.sh`. The first pass downloads every PDF once (~42k, roughly 7–8 MB each in
  dev's sample, so a few hundred GB); `INGEST_WORKERS` sets its concurrency (default 4).
