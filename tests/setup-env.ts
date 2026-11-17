import 'dotenv/config';
import fc from 'fast-check';

/**
 * Integration tests must never touch the dev database: they truncate every table. Point the whole
 * process at `TEST_DATABASE_URL` before anything imports `@/db` and opens a pool.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Better Auth, for the auth tests. The origin matches the in-process test client.
process.env.BETTER_AUTH_URL = 'http://test.local';
process.env.APP_URL = 'http://test.local';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-0000';
process.env.ADMIN_EMAILS = 'admin@example.org';
// Sign-up is limited to these domains in tests (example.org, ethz.ch, mit.edu), and the orgs bot finds these ROR ids.
process.env.INSTITUTION_DOMAINS_PATH = 'tests/fixtures/institution-domains.json';
process.env.INSTITUTION_ROR_PATH = 'tests/fixtures/institution-ror.json';

// Property tests run the same cases every time, so a failure reproduces and CI never goes red by chance. To look
// for new counterexamples, run with FC_SEED set to anything else (`FC_SEED=$RANDOM npm test`).
fc.configureGlobal({ seed: Number(process.env.FC_SEED ?? 20261117) });
