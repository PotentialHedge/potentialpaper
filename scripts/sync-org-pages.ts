import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { syncOrgPages } from '@/server/org-pages';

const USAGE = `The \`orgs\` bot (handoffs/pages.md Phase 4): makes an organisation page (/o/<key>) per institution on the
sign-up allowlist (config/institution-domains.json and the institution_domains table), each with an org.json holding
its name, every domain the list gives that name, and its ROR id where config/institution-ror.json has one. The
domains make people its members and papers its papers. Idempotent: it never removes anything, and on a page whose
org.json is there it only adds missing domains and a missing ROR id.

By default, the institutions in use: a confirmed address, an address printed on a paper's page 1, or a domain an
admin added. Confirming an address and each PDF ingest pass make their institutions' pages too.

  npm run orgs:sync
  npm run orgs:sync -- --domain ethz.ch [--domain mit.edu]
  npm run orgs:sync -- --all          # every institution on the list (tens of thousands of pages)`;

async function main() {
  const { values } = parseArgs({
    options: {
      all: { type: 'boolean' },
      domain: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const report = await syncOrgPages({ all: values.all, domains: values.domain });
  for (const key of report.written) console.log(`wrote org:${key}`);
  for (const domain of report.unknown) console.log(`${domain} is on no institution list`);
  console.log(`${report.written.length} pages written`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
