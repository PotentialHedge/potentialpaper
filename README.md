# PotentialPaper

## Local development

Needs Node (see `.node-version`) and Docker.

```sh
npm install
cp .env.example .env          # then set BETTER_AUTH_SECRET (`openssl rand -base64 32`)
docker compose -f docker-compose.dev.yml up -d   # Postgres on 127.0.0.1:55433
npm run db:seed               # wipe, migrate and fill the database (~35 s)
npm run dev                   # http://localhost:3000
```

Sign in as `dev@ethz.ch` (or `ada@cam.ac.uk`, `alan@mit.edu`) with the password `papertrail-dev`. Add
`dev@ethz.ch` to `ADMIN_EMAILS` in `.env` to be an admin. Mail (sign-in codes, links) is printed to the dev
server's log.

`npm run db:seed` is also the reset: rerun it any time. It only touches a database on localhost. The data:

- `scripts/seed/fixture.json`: 450 real ICLR papers, 2026 (accepted, rejected, withdrawn, with reviews) and 2027
  (under review, with their reviews so far from acceptodds, and 400 more with their scores only so the venue's
  score distribution has its real shape: `npm run db:seed:acceptodds-reviews`), and 15 accepted NeurIPS 2026
  papers from acceptodds. 5 of the NeurIPS papers and 5 of the ICLR 2027 ones were rejected or withdrawn at ICLR
  2026 first (`--resubmissions`); the seed merges each such pair into one paper. Add a venue's sample from an OpenReview scrape with
  `npm run db:seed:export`, or an acceptodds kind with `npm run db:seed:export-acceptodds` (`-h` for usage).
- `scripts/seed/seed.ts`: people, topics and comments. Edit the lists at the top to add more.

The seed runs the background consumers itself, so search, venue pages and score stats are ready. To keep them
current while you edit pages, run the worker too: `npm run consumers:work`.
