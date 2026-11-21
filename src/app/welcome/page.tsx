import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { safeReturnTo } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { listedInstitutionCount } from '@/server/institution-domains';
import { siteUrl } from '@/server/site';
import { Welcome } from './Welcome';

export const dynamic = 'force-dynamic';

/** Sign-up: an institutional email, and a way to ask for the institution when it is refused. */
export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeReturnTo((await searchParams).next);
  if (await viewerFromHeaders(await headers())) redirect(next === '/' ? '/profile' : next);
  return <Welcome next={next} institutionCount={listedInstitutionCount()} host={new URL(siteUrl()).host} />;
}
