# TODO for Benedict

Things only you can do or decide. Most urgent first.

- [ ] **acceptodds is running vulnerable Next 16.4.0 in production.** `npm audit` lists critical advisories,
      including unauthenticated remote code execution. Fix it, or ask me to.
- [ ] **Review Milestone 1 on the live site.** Try https://papers.potentialhedge.com/abs/1706.03762, the search
      link in the header, and the home page. It's on the branch `milestone-1-papers`, deployed but not pushed.
      Tell me whether to push it and merge to `main` (CI hasn't run on it).
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
- [ ] **Contribution license.** Must be settled before the Milestone 3 alpha. The starting proposal is CC BY-SA
      for community content and CC BY for author sections.
- [ ] **Pick your handle.** The admin account still has the placeholder `user-rjxn6s`. The password is in
      `~/.config/papertrail/admin-password`.
