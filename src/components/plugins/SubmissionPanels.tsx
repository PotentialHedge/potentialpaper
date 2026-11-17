'use client';

import { Fragment, useMemo } from 'react';
import { arrangePanels } from '@/lib/panels';
import { useSetting } from '@/lib/settings/client';
import { usePluginPanels } from './PluginPanel';

/**
 * The reader's plugins' panels in `paper.submission`, under one submission in the Submissions section: a venue's
 * score distribution beside the paper's own reviews, say. Hidden and ordered by `paper.panels.hidden` and `.order`
 * like any panel; nothing until the plugin list arrives, so the cached page is unchanged.
 */
export function SubmissionPanels({ venue, hasScores }: { venue: { id: string; name: string }; hasScores: boolean }) {
  const hidden = useSetting<string[]>('paper.panels.hidden');
  const order = useSetting<string[]>('paper.panels.order');
  // Stable while the page is, so the frames aren't rebuilt on every render.
  const submission = useMemo(
    () => ({ venue: { id: venue.id, name: venue.name }, hasScores }),
    [venue.id, venue.name, hasScores],
  );
  const panels = usePluginPanels('paper.submission', submission);
  const byId = new Map(panels.map((p) => [p.id, p.node]));
  return arrangePanels(
    panels.map((p) => p.id),
    hidden,
    order,
  ).map((id) => <Fragment key={id}>{byId.get(id)}</Fragment>);
}
