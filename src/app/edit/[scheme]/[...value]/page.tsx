import { redirect } from 'next/navigation';
import { editHref, toolPaper, type ToolParams } from '@/components/paper/page-tools';

export const dynamic = 'force-dynamic';

/** Older links (`/edit/abs/1706.03762?part=author`): the page's files are edited in the web editor now. */
export default async function EditPage({ params }: { params: ToolParams }) {
  const { id } = await toolPaper('edit', params);
  redirect(editHref(id));
}
