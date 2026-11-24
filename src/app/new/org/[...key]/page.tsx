import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ui } from '@/components/ui';
import { getDb } from '@/db';
import { pageCurrent } from '@/db/schema';
import { formatIdentifier, keyedPagePath, keyProblem, KINDS, type OrgFile, pageName } from '@/lib/kinds';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { isOrgMember } from '@/server/org-roles';
import { findKeyedPage } from '@/server/pages/kinds';
import { NewDepartmentForm } from './NewDepartmentForm';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ key: string[] }> };

async function load(params: Props['params']) {
  const key = (await params).key.map(decodeURIComponent).join('/');
  if (keyProblem('org', key) || key.split('/').length >= KINDS.org.maxDepth) notFound();
  const page = await findKeyedPage(getDb(), 'org', key);
  if (!page) notFound();
  const [current] = await getDb()
    .select({ name: pageCurrent.name, kindFile: pageCurrent.kindFile })
    .from(pageCurrent)
    .where(eq(pageCurrent.pageId, page.id));
  const domains = ((current?.kindFile ?? null) as OrgFile | null)?.domains ?? [];
  return { page, key, name: current?.name ?? pageName('org', key, null), domains };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name } = await load(params);
  return { title: `Add a department or lab to ${name} · potentialpaper`, robots: { index: false, follow: false } };
}

/**
 * Making a department or lab under an organisation (`handoffs/pages.md` Phase 4): a child org page, `org:<key>/<slug>`,
 * made by one of the organisation's verified members (`server/org-pages.ts`'s `createOrgChild`). Its papers roll up
 * into the organisation's; its own domains, if any, are the organisation's or under them.
 */
export default async function NewDepartmentPage({ params }: Props) {
  const { page, key, name, domains } = await load(params);
  const path = keyedPagePath('org', key);
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', `/new/org/${key}`));
  const member =
    viewer.isAdmin || (viewer.account.verifiedAt !== null && (await isOrgMember(getDb(), page, viewer.account.id)));
  return (
    <main className={ui.page}>
      <p className={`${ui.fine} mt-6 font-sans`}>
        <a href={path}>{name}</a>
      </p>
      <h1 className="mt-1 text-[26px] leading-tight font-normal">Add a department or lab to {name}</h1>
      <div className="mt-5 max-w-[640px] font-sans text-sm">
        <p>
          A department or lab is a page of its own under {name}, at <code>{path}/…</code>. Its papers count among {name}
          &apos;s. Give it its own email domains (such as <code>inf.{domains[0] ?? 'example.org'}</code>) to have papers
          with addresses there, and its members&apos; papers, counted as its own.
        </p>
        {member ? (
          <NewDepartmentForm identifier={formatIdentifier({ kind: 'org', key })} parentKey={key} domains={domains} />
        ) : (
          <p className="mt-4">
            Only {name}&apos;s verified members add departments and labs: someone with a confirmed address at{' '}
            {domains.length > 0 ? domains.join(', ') : 'one of its domains'}.{' '}
            <a href="/profile#affiliations">Add an address on your profile</a>.
          </p>
        )}
      </div>
    </main>
  );
}
