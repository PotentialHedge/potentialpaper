import { redirect } from 'next/navigation';
import { editHref, first, toolPaper, type ToolParams, type ToolSearchParams } from '@/components/paper/page-tools';

export const dynamic = 'force-dynamic';

type Props = { params: ToolParams; searchParams: ToolSearchParams };

/**
 * Editing happens on the paper's page, in place (`components/paper/edit`). This address, which older links
 * and bookmarks have (`/edit/abs/1706.03762?part=author&section=2`), opens the same editor there.
 */
export default async function EditPage({ params, searchParams }: Props) {
  const query = await searchParams;
  const part = first(query.part);
  const section = Math.max(0, Math.min(1000, Number.parseInt(first(query.section) ?? '0', 10) || 0));
  const { id } = await toolPaper('edit', params);
  if (part === 'card') redirect(editHref(id, 'picture'));
  const which = part === 'author' ? 'author' : 'community';
  redirect(editHref(id, section ? `${which}-${section}` : which));
}
