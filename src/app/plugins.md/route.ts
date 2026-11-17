import { markdown } from '@/server/agent/text';
import { pluginsGuide } from '@/server/agent/plugins-guide';
import { siteUrl } from '@/server/site';

export const dynamic = 'force-dynamic';

/** `/plugins.md`: how to build, try and publish a plugin, for agents (`handoffs/plugins.md` Phase 3). */
export function GET() {
  return markdown(pluginsGuide(siteUrl()));
}
