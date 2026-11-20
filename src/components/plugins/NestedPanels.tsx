'use client';

import { Fragment, useMemo } from 'react';
import { arrangePanels } from '@/lib/panels';
import { useSetting } from '@/lib/settings/client';
import { type PanelSubmission, usePluginPanels } from './PluginPanel';

/**
 * The reader's plugins' panels in a slot drawn inside a built-in panel (`SLOT_PARENTS`): `paper.submission`, under
 * one submission, `paper.community`, at the end of the Community section, or `paper.author`, at the end of the
 * author section. Hidden and ordered by
 * `paper.panels.hidden` and `.order` like any panel; nothing until the plugin list arrives, so the cached page is
 * unchanged.
 */
function NestedPanels({ slot, submission }: { slot: string; submission?: PanelSubmission }) {
  const hidden = useSetting<string[]>('paper.panels.hidden');
  const order = useSetting<string[]>('paper.panels.order');
  const panels = usePluginPanels(slot, submission);
  const byId = new Map(panels.map((p) => [p.id, p.node]));
  return arrangePanels(
    panels.map((p) => p.id),
    hidden,
    order,
  ).map((id) => <Fragment key={id}>{byId.get(id)}</Fragment>);
}

/** Under one submission in the Submissions section: a venue's score distribution beside the paper's own reviews, say. */
export function SubmissionPanels({ venue, hasScores }: { venue: { id: string; name: string }; hasScores: boolean }) {
  // Stable while the page is, so the frames aren't rebuilt on every render.
  const submission = useMemo(
    () => ({ venue: { id: venue.id, name: venue.name }, hasScores }),
    [venue.id, venue.name, hasScores],
  );
  return <NestedPanels slot="paper.submission" submission={submission} />;
}

/** At the end of the Community section, in the page's main text: the paper's place on a map, say. */
export function CommunityPanels() {
  return <NestedPanels slot="paper.community" />;
}

/** At the end of the author section: only the panels its authors list in `owners/plugins.json`. */
export function AuthorPanels() {
  return <NestedPanels slot="paper.author" />;
}
