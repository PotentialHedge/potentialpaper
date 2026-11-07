# TODO for Benedict

Things only you can do or decide, most urgent first. Milestones 1 and 2 and the ICLR import are merged into
`main`. Next up is Milestone 3, community editing.

## Urgent

- [ ] **acceptodds is running vulnerable Next 16.4.0 in production.** `npm audit` lists critical advisories,
      including unauthenticated remote code execution. Fix it, or ask me to.
- [ ] **The live site still runs under the old name.** Its containers, volume and database are still `papertrail`.
      Until they are migrated, deploy into that project: add `-p papertrail` to every `docker compose` command in
      `docker-compose.prod.yml`'s header, or it starts a new `potentialpaper` project with an empty database and
      clashing routes. The server's `.env.production` names the `papertrail` database user and database again (its
      copy from before 2026-11-07 is in `~/backups`). A migration must also replay the page commits, because the
      system author in their hashes changed.

## Before the Milestone 3 alpha

- [ ] **Contribution license.** The starting proposal is CC BY-SA for community content and CC BY for author
      sections.
- [ ] **Decide how production purges the edge.** Once pages show edits, each commit has to purge that page from
      Cloudflare, so the app needs a token. I'd make one limited to cache purge on this zone, and put it in
      `.env.production`. Production doesn't have one yet.
- [ ] **Mail and final domain.** Sign-up fails on the live site until production has `RESEND_API_KEY` and
      `MAIL_FROM`, and watchlist digests will need them too. Set up the domain (`potentialpaper.com` is the
      candidate) and a Resend key.
- [ ] **Review the UI** on https://papers.potentialhedge.com and send feedback, since later pages copy the current
      look. Good places to start: the home page and its search, https://papers.potentialhedge.com/abs/1706.03762,
      an ICLR paper with its PDF link and reviews, and
      `git clone https://papers.potentialhedge.com/git/arxiv/1706.03762.git`.

## Content and licensing

- [ ] **Keep or remove the test commits on the live site.** To check clones, I made 5 commits on
      _Attention Is All You Need_ (`arxiv:1706.03762`): the metadata snapshot, then two test edits by a new
      labeled bot account, `papertrail-bot`, and two reverts of them. The page has only `metadata.json` now,
      and its web page is unchanged, but the test edits stay in its public history. To remove the repo, run this
      on the production database, then `scripts/purge-edge-cache.sh`:
      `delete from page_events where paper_id = X; delete from page_current where paper_id = X; delete from page_revisions where paper_id = X; delete from page_refs where paper_id = X; delete from page_objects where paper_id = X;`
      with `X` as `(select paper_id from paper_identifiers where scheme = 'arxiv' and value = '1706.03762')`.
- [ ] **Decide about the ICLR 2026 PDFs.** They aren't local, and downloading them needs an OpenReview login, so those
      pages only link to OpenReview. The ICLR 2027 list is the Oct 3 scrape, not refreshed.
- [ ] **Decide about 16 ICLR 2027 PDFs I didn't link.** They open with "Published as a conference paper at ICLR 2027"
      during review, so they may name their authors. Their bytes are in R2, public to anyone with the hash.
- [ ] **Set up a takedown route** for hosted PDFs, and consider asking policy@openreview.net about re-hosting.
- [ ] **Decide the license policy for paper text across versions.** The plan is to extract each version's
      text (arXiv LaTeX, OpenReview PDFs) into `refs/heads/paper` so versions can be diffed. Unlike metadata
      and reviews, full text belongs to the authors: most arXiv papers are under arXiv's non-exclusive
      license, which doesn't allow redistribution, and OpenReview's terms say not to modify downloaded
      submissions. Options: only papers under an open license, everything with a takedown route, or ask
      policy@openreview.net. Parked for now; each version's commit will record the license either way.
- [ ] **Check the abstract policy.** For papers found by DOI, I only show abstracts under an open license, so
      many publisher papers show none. arXiv abstracts always show. Loosen this only if you're comfortable
      with the licensing.

## Housekeeping

- [ ] **Stale design docs.** You stopped my earlier update of `DESIGN.md` and `IMPLEMENTATION.md`. Should I redo
      it? They still describe an in-memory domain overlay, a `ror_id` / `request_id` schema and a strict CSP, and
      Milestone 2 differs from `DESIGN.md` in three ways. `node-diff3` is gone: it took 12 seconds on a
      2,000-line file of repeated lines while holding the page's lock, so merging now uses `diff`, with limits.
      `page_current` holds Markdown rather than HTML until rendering arrives in Milestone 3. A new private table,
      `commit_identities`, ties `u_` ids to accounts, so `page_revisions` can be rebuilt.
- [ ] **Pick your handle.** The admin account still has the placeholder `user-rjxn6s`. The password is in
      `~/.config/papertrail/admin-password`.
