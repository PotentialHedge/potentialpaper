import { KeyedPageRoute, keyedPageMetadata } from '@/components/pages/page-route';

/** A org page (`lib/kinds.ts`), at `/o/<key>`. */
type Props = { params: Promise<{ key: string[] }> };

// Rendered on the first request, then cached; what links here and a scope's papers change with other pages'
// commits, which the consumers write, so the copy is kept for minutes rather than a day.
export const revalidate = 300;
export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: Props) {
  return keyedPageMetadata('org', (await params).key);
}

export default async function Page({ params }: Props) {
  return <KeyedPageRoute kind="org" segments={(await params).key} />;
}
