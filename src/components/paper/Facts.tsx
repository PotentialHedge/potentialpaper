import { AddFactRow, OwnFactRows } from '@/components/pages/OwnFacts';
import { ui } from '@/components/ui';
import { type PaperFacts, VENUE_ROW_LABEL } from '@/lib/paper-facts';

/**
 * The infobox's facts about a paper, a row each as Wikipedia's: where it was accepted, presented and sent, its area and
 * keywords, then the rows its authors and the community added. Built from `paperFacts` (`lib/paper-facts.ts`), as the
 * page's JSON-LD and meta tags are, so they never disagree. A venue links to its page here.
 */
export function Facts({ facts, pagePath }: { facts: PaperFacts; pagePath: string }) {
  return (
    <div className={ui.box}>
      <table className={`${ui.facts} empty:hidden`}>
        <tbody>
          {facts.venues.map((v, i) => (
            <tr key={i}>
              <th scope="row">{VENUE_ROW_LABEL[v.status ?? 'unknown']}</th>
              <td>
                {v.path ? (
                  <a
                    href={v.path}
                    className="text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink"
                  >
                    {v.venue}
                  </a>
                ) : (
                  v.venue
                )}
                {(v.presentation || v.site) && (
                  <div className="text-muted">
                    {[v.presentation, v.site && `in ${v.site}`].filter(Boolean).join(', ')}
                  </div>
                )}
              </td>
            </tr>
          ))}
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
