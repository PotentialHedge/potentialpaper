# TODO for Benedict

Things only you can do or decide. Most urgent first.

- [ ] **acceptodds is running vulnerable Next 16.4.0 in production.** `npm audit` lists critical advisories,
      including unauthenticated remote code execution. Fix it, or ask me to.
- [ ] **Review Milestone 1 on the live site.** Try https://papers.potentialhedge.com/abs/1706.03762, the search
      link in the header, and the home page. It's on the branch `milestone-1-papers`, pushed and deployed. Tell me
      whether to merge it to `main`.
- [ ] **Review Milestone 2 and tell me whether to merge it.** It's on `milestone-2-git-store`, on top of
      `milestone-1-papers`, pushed and deployed. Try it:
      `git clone https://papers.potentialhedge.com/git/arxiv/1706.03762.git`.
- [ ] **Keep or remove the test commits on the live site.** To check clones, I made 5 commits on
      _Attention Is All You Need_ (`arxiv:1706.03762`): the metadata snapshot, then two test edits by a new
      labeled bot account, `papertrail-bot`, and two reverts of them. The page has only `metadata.json` now,
      and its web page is unchanged, but the test edits stay in its public history. To remove the repo, run this
      on the production database, then `scripts/purge-edge-cache.sh`:
      `delete from page_events where paper_id = X; delete from page_current where paper_id = X; delete from page_revisions where paper_id = X; delete from page_refs where paper_id = X; delete from page_objects where paper_id = X;`
      with `X` as `(select paper_id from paper_identifiers where scheme = 'arxiv' and value = '1706.03762')`.
- [ ] **Decide how production purges the edge, before Milestone 3.** Once pages show edits, each commit has to
      purge that page from Cloudflare, so the app needs a token. I'd make one limited to cache purge on this zone,
      and put it in `.env.production`. Production doesn't have one yet.
- [ ] **Decide whether to publish the ICLR 2027 submissions.** All 42,425 are imported in the dev database only.
      I held back from production because it puts abstracts of papers under review on a public site, and I
      haven't checked OpenReview's terms. If you're happy with that, run:
      `docker compose -f docker-compose.prod.yml --env-file .env.production run --rm -T -v "$PWD/../papermarket/platform/data/iclr2027.sqlite:/data/iclr.sqlite:ro" tools npm run -s papers:import-iclr -- /data/iclr.sqlite`
- [ ] **Check the abstract policy.** For papers found by DOI, I only show abstracts under an open license, so
      many publisher papers show none. arXiv abstracts always show. Loosen this only if you're comfortable
      with the licensing.
- [ ] **Mail and final domain.** Sign-up fails on the live site until production has `RESEND_API_KEY` and
      `MAIL_FROM`. Set up the domain (`potentialpaper.com` is the candidate) and a Resend key.
- [ ] **Review the UI** and send feedback, since later pages copy the current look.
- [ ] **Stale docs.** You stopped my earlier update of `DESIGN.md` and `IMPLEMENTATION.md`. Should I redo it?
      Milestone 2 adds three differences from `DESIGN.md`. `node-diff3` is gone: it took 12 seconds on a 2,000-line
      file of repeated lines while holding the page's lock, so merging now uses `diff`, with limits. `page_current`
      holds Markdown rather than HTML until rendering arrives in Milestone 3. A new private table,
      `commit_identities`, ties `u_` ids to accounts, so `page_revisions` can be rebuilt.
- [ ] **Contribution license.** Must be settled before the Milestone 3 alpha. The starting proposal is CC BY-SA
      for community content and CC BY for author sections.
- [ ] **Pick your handle.** The admin account still has the placeholder `user-rjxn6s`. The password is in
      `~/.config/papertrail/admin-password`.
