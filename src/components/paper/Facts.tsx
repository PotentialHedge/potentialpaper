import { AddFactRow, OwnFactRows } from '@/components/pages/OwnFacts';
import { ui } from '@/components/ui';
import type { PaperFacts } from '@/lib/paper-facts';

/**
 * The infobox's facts about a paper, a row each as Wikipedia's: where it was accepted and presented, its area and
 * keywords, then the rows its authors and the community added. Where else it was sent is the Versions box's. Built from `paperFacts` (`lib/paper-facts.ts`), as the
 * page's JSON-LD and meta tags are, so they never disagree. A venue links to its page here.
 */
export function Facts({ facts, pagePath }: { facts: PaperFacts; pagePath: string }) {
  const { published } = facts;
  return (
    <div className={ui.box} data-link-area="facts">
      <table className={`${ui.facts} empty:hidden`}>
        <tbody>
          {published && (
            <tr>
              <th scope="row">Accepted at</th>
              <td>
                {published.path ? (
                  <a
                    href={published.path}
                    className="text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink"
                  >
                    {published.venue}
                  </a>
                ) : (
                  published.venue
                )}
                {(published.presentation || published.site) && (
                  <div className="text-muted">
                    {[published.presentation, published.site && `in ${published.site}`].filter(Boolean).join(', ')}
                  </div>
                )}
              </td>
            </tr>
          )}
          {facts.area && (
            <tr>
              <th scope="row">Area</th>
              <td title={`As the authors chose it at ${facts.area.venue}`}>{facts.area.name}</td>
            </tr>
          )}
          {facts.keywords.length > 0 && (
            <tr>
              <th scope="row">Keywords</th>
              <td className="text-muted">{facts.keywords.join(', ')}</td>
            </tr>
          )}
          <OwnFactRows facts={facts.own} ownersTitle="the authors" />
        </tbody>
      </table>
      <AddFactRow pagePath={pagePath} />
    </div>
  );
}
