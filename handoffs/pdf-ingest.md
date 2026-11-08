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
