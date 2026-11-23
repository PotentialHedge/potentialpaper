import { ui } from '@/components/ui';
import { type PaperFacts, VENUE_ROW_LABEL } from '@/lib/paper-facts';

/**
 * The infobox's facts about a paper, a row each as Wikipedia's: where it was accepted, presented and sent, and its
 * keywords. Built from `paperFacts` (`lib/paper-facts.ts`), as the page's JSON-LD and meta tags are, so the three never
 * disagree. Each row links to where the fact is shown in full: a venue to its page here.
 */
export function Facts({ facts }: { facts: PaperFacts }) {
  if (facts.venues.length === 0 && facts.keywords.length === 0) return null;
  return (
    <div className={ui.box}>
      <table className={ui.facts}>
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
          {facts.keywords.length > 0 && (
            <tr>
              <th scope="row">Keywords</th>
              <td className="text-muted">{facts.keywords.join(', ')}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
