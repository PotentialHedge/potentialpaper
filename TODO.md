# TODO for Benedict

Things only you can do or decide, most urgent first. Milestones 1 and 2 and the ICLR import are merged into
`main`. Next up is Milestone 3, community editing.

## Urgent

- [ ] **acceptodds is running vulnerable Next 16.4.0 in production.** `npm audit` lists critical advisories,
      including unauthenticated remote code execution. Fix it, or ask me to.

## Before the Milestone 3 alpha

- [ ] **Contribution license.** The starting proposal is CC BY-SA for community content and CC BY for author
      sections.
- [ ] **Decide how production purges the edge.** Pages now show edits, so each commit has to purge that page from
      Cloudflare, and the app needs a token. Until it has one, the editor sees its own edit (it reloads with
      `?v=`), but other readers get the edge's copy until it expires. I'd make one limited to cache purge on this zone, and put it in
      `.env.production`. Production doesn't have one yet.
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

## Later

- [ ] **Set up git over SSH properly** (on hold, 2026-11-15). The code is merged and deployed in the image
      (`npm run git:ssh`, `src/server/git/ssh.ts`, keys from the profile page), but the `ssh` service isn't started,
      so only HTTPS clone and push work. Until then, `docs/git.md` and the profile's example assume
      `git.papers.potentialhedge.com:2222`, and the host key fingerprint is a placeholder. To decide: - **DNS:** a DNS-only (grey-cloud) A record, e.g. `git.papers.potentialhedge.com` → `77.244.248.196`. It
      exposes the origin IP (the web stays behind Cloudflare, since Traefik only admits it on 80/443). - **Port:** 2222 published (simplest), 22 with the host's sshd moved to another port or Tailscale-only (so
      `git@host:abs/<id>.git` works as on GitHub), or a second IPv4 for git on 22. Moving later only changes
      `GIT_SSH_PUBLISH` and `GIT_SSH_URL`.

      Then the steps (DEPLOY.md, "Git over SSH"): `ssh-keygen -t ed25519 -N '' -f secrets/ssh_host_ed25519_key` on
      the server, once, backed up with `.env.production`; create the DNS record; set `GIT_SSH_URL` (and
      `GIT_SSH_PUBLISH` if not 2222) in `.env.production`; open the port in the provider's firewall (Docker bypasses
      ufw); `dc --profile tools up -d ssh`; check `dc logs ssh` for the fingerprint and `ssh -T -p <port> git@<host>`;
      put the fingerprint in `docs/git.md` and fix its address if it changed. Also worth doing then: show clone/SSH
      addresses on a paper's page and link `docs/git.md` from the site, and answer `git-lfs-authenticate` over SSH
      so Git LFS works in an SSH clone without setting `lfs.url` (docs/git.md says to set it for now).

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
