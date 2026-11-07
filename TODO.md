# TODO for Benedict

Things only you can do or decide, most urgent first. Milestones 1 and 2 and the ICLR import are merged into
`main`. Next up is Milestone 3, community editing.

## Urgent

- [ ] **acceptodds is running vulnerable Next 16.4.0 in production.** `npm audit` lists critical advisories,
      including unauthenticated remote code execution. Fix it, or ask me to.

## Before the Milestone 3 alpha

- [ ] **Contribution license.** The starting proposal is CC BY-SA for community content and CC BY for author
      sections.
- [ ] **Decide how production purges the edge.** Once pages show edits, each commit has to purge that page from
      Cloudflare, so the app needs a token. I'd make one limited to cache purge on this zone, and put it in
      `.env.production`. Production doesn't have one yet.
- [ ] **Check that production has R2 keys for demos.** Attaching a demo stores its files in R2, so
      `.env.production` needs `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, the same keys the
      PDF scripts use. I couldn't reach the server to check.
- [ ] **Buy the domains and move demos onto their own.** Demos (sandboxed user code from GitHub repos)
      are served from `papers-content.potentialhedge.com` for now, one path per demo. That host shares a
      site with the app, so it isn't a real sandbox. Before anyone outside tries demos, buy a separate
      domain (`ppusercontent.com`, $11.17/yr on Cloudflare, was available on 2026-11-07), give each demo its
      own subdomain with wildcard DNS, set `DEMO_ORIGIN`, and harden it: `__Host-` auth cookies, Origin
      checks on writes, and a strict CSP on the demo host. `potentialpaper.com` was also available at the
      same price.
- [ ] **Mail and final domain.** Sign-up fails on the live site until production has `RESEND_API_KEY` and
      `MAIL_FROM`, and watchlist digests will need them too. Set up the domain (`potentialpaper.com` is the
      candidate) and a Resend key.
- [ ] **Review the UI** on https://papers.potentialhedge.com and send feedback, since later pages copy the current
      look. Good places to start: the home page and its search, https://papers.potentialhedge.com/abs/1706.03762,
      an ICLR paper with its PDF link and reviews, and
      `git clone https://papers.potentialhedge.com/git/openreview/jJbc2wpXoo.git`.

## Content and licensing

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
      it? They still describe a strict CSP, and Milestone 2 differs from `DESIGN.md` in three ways. `node-diff3` is
      gone: it took 12 seconds on a 2,000-line file of repeated lines while holding the page's lock, so merging now
      uses `diff`, with limits. `page_current` holds Markdown rather than HTML until rendering arrives in
      Milestone 3. A new private table, `commit_identities`, ties `u_` ids to accounts, so `page_revisions` can be
      rebuilt.
