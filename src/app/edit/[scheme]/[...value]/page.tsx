import { redirect } from 'next/navigation';
import { toolPage, type ToolParams } from '@/components/pages/page-tools';
import { toolPath } from '@/lib/page-tools';

export const dynamic = 'force-dynamic';

/** Older links (`/edit/abs/1706.03762?part=author`): a page's files are edited in the web editor now. */
export default async function EditPage({ params }: { params: ToolParams }) {
  const { address } = await toolPage('edit', params);
  redirect(toolPath('code', address));
}
