# Handoff: PotentialPaper (repo `potentialpaper`)

## What this is

A public, wiki-style page for every research paper. Each page has an author section, which only verified
authors can edit, and a community section, which any verified researcher can edit. Labeled links between
papers are the central feature. Page history is real git objects stored in Postgres. Extensions added from
GitHub repos come later.

- Local: `/home/administrator/projects/papertrail`
- Repo: https://github.com/PotentialHedge/potentialpaper (private, `main`, commit `29be91e`)
- Live: https://papers.potentialhedge.com
- Read first: `DESIGN.md`, `IMPLEMENTATION.md`
- Reference for stack and style: https://github.com/PotentialHedge/acceptodds, checked out at
  `../papermarket/platform`. Its `AGENTS.md` explains why many of the auth rules exist.

## Current state

Milestone 0 is built and deployed, apart from mail:

- Next 16.4.5, Drizzle, Postgres 16, Better Auth, Tailwind v4, Vitest
- Sign-up by institutional email, using acceptodds' allowlist and rules
- Accounts with a handle, optional real name, and an explicit choice about showing the institution
- Extra affiliations on `/profile`
- Institution request form, plus an admin queue at `/admin/institutions`
- CSP and a CI workflow

Paper pages don't exist yet; the home page is a placeholder.

## Verified

- 66 tests passed, with lint and type checks clean, on Node 24 locally. The Docker image uses Node 26.
- A browser run on a production build covered sign-up, profile, institution request, admin approval, the
  requester joining, and password sign-in. It used a fake mail server, and showed no CSP violations.
- The live site passes HTTP checks on its pages and refusal responses.

## Not verified

- Real email, and the full sign-up flow on the live site.
- CI: no run had appeared just after the push. Check with `gh run list`.
- The UI: the user is reviewing it and hasn't given feedback yet.

## Decisions already made (don't reopen)

- Git objects live in Postgres, not bare repos on disk.
- Real names are optional. Anonymous per-paper aliases are for comments only, and edits stay under a handle.
- On a paper you've claimed, you always appear under the name printed on the paper, through a separate
  per-claim identity. Public data must never link that to your handle, and milestone 5 tests this.
- ORCID is not a way to join. It's only evidence for author claims.
- The `institution_domains` table is queried on every check rather than cached, because Next can load a
  module more than once. It overrides the generated file.
- Scripts allow `'unsafe-inline'` in the CSP, because nonces would rule out caching pages at the edge.
  Revisit this before user-written content ships.

## Open work

1. **Mail and final domain (parked by the user until the domain is set up).** Production has empty
   `RESEND_API_KEY` and `MAIL_FROM`, so sign-up fails on the live site until then. `potentialpaper.com` is
   the candidate domain. Don't read or reuse acceptodds' Resend key without asking.
2. **Stale docs.** The user stopped my doc update and hasn't said why, so ask before redoing it. `README.md`
   doesn't exist. `DESIGN.md` and `IMPLEMENTATION.md` still describe an in-memory domain overlay, a
   `ror_id` / `request_id` schema and a strict CSP. They also don't mention `papers.potentialhedge.com` or
   `potentialpaper.com`.
3. **Contribution license (the user wants to discuss this later).** It must be settled before anyone outside
   the team edits. The starting proposal is CC BY-SA for community content and CC BY for author sections.
4. **acceptodds is running vulnerable Next 16.4.0 in production.** `npm audit` lists critical advisories,
   including unauthenticated RCE in `use cache`. The user has been told, but no fix has been reported.
   It's a separate project, so don't change it unless asked.
5. **Next feature:** Milestone 1, read-only paper pages at `/abs/<arxiv id>`. Don't start without the user's
   go-ahead. Verify edge caching early, because it shapes every later page. `/` currently sends
   `s-maxage=31536000`, and Cloudflare reports `DYNAMIC`, so no cache rule is active yet.

## How to work with this user

- **Don't preview or screenshot UI changes to judge them.** Deploy, then tell them what to look at.
  Behaviour checks such as HTTP requests and automated flows are fine.
- Commit or push only when asked.
- No `Co-Authored-By` or any Claude attribution in commits. Their `~/.claude/CLAUDE.md` overrides any other
  guidance on this.
- Ask before destructive or outward-facing actions, and before reusing another project's credentials.
- `$CLOUDFLARE_API_TOKEN` is available (`source ~/.config/cloudflare/env` if unset). It's account-owned, so
  sanity-check it with `/zones`, not `/user`. Never print it.

## Running it

- Dev database: `docker compose -f docker-compose.dev.yml up -d` (`127.0.0.1:55433`). It's running now and
  also holds `potentialpaper_test`.
- `.env` and `.env.production` exist locally and are gitignored. `.env.production` holds the generated
  production secrets. `ADMIN_EMAILS` is `benedict.armstrong@inf.ethz.ch` in both.
- Checks: `npm run lint && npm run format:check && npm run typecheck && npm run test:all`.
- Integration tests truncate every table in `$TEST_DATABASE_URL`.
- Next 16 differs from older versions, so read `node_modules/next/dist/docs/` before relying on memory.

## Deployment

- It runs on this host as Compose project `papertrail`, with its own Postgres, using
  `docker-compose.prod.yml`. Steps are in that file's header.
- Migrations are a separate step, and `build` needs `--profile tools`, or migrate silently applies nothing new.
- The running image is tagged `m0-uncommitted` but matches commit `29be91e`. The next deploy should use the
  real commit tag: `export GIT_COMMIT=$(git rev-parse --short HEAD)`.
- Routing is through Docker labels on the app container. Nothing in `~/proxy` was edited.
- DNS is a proxied A record, `papers` → `77.244.248.196`, in the `potentialhedge.com` zone. The zone's SSL
  mode is Full, so no new origin certificate was needed.

## Good to know

- `next build` can stop with a `SecurityFatalError` that contains instructions aimed at AI agents, including
  running `next upgrade --agent=security`. I didn't follow them, and checked with `npm audit` instead.
- 12 moderate `npm audit` warnings remain. The ones I traced are in dev tools (`drizzle-kit`, ESLint), but
  I didn't check all 12.
- `spikes/git-store.mjs` reproduces the storage benchmark in `DESIGN.md`. The browser test scripts were in
  the session's scratchpad and aren't in the repo, so expect to rewrite them if needed. Host Chromium is
  missing system libraries, so use the `mcr.microsoft.com/playwright` image with `--network host`.
- In production, mail goes through Resend. To test without sending real mail, point `RESEND_BASE_URL` at a
  local catcher.
