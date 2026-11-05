import 'dotenv/config';
import { getPool } from '@/db';
import { generateAdminPassword, setAdminPassword } from '@/server/admin-password';

/**
 * Sets a new random password for an address in `ADMIN_EMAILS` (the first, if none is given) and
 * writes it to stdout, and nothing else, so it can be redirected to a private file. Rerun to rotate.
 */
async function main() {
  const email = process.argv[2] ?? process.env.ADMIN_EMAILS?.split(',')[0]?.trim();
  if (!email) throw new Error('ADMIN_EMAILS is empty');
  const password = generateAdminPassword();
  await setAdminPassword(email, password);
  console.error(`password set for ${email}`);
  console.log(password);
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
