import { Fragment } from 'react';
import { AddMissing } from '@/components/paper/AddMissing';
import { ui } from '@/components/ui';
import type { FactLine, PageFacts } from '@/lib/infobox-facts';

/**
 * The rows people added to a page's infobox (`lib/infobox-facts.ts`), under the ones it reads from where each fact is
 * kept: the owners' first, then the community's, each group named so "the authors' code" and "someone's reproduction"
 * read apart. Rows of a `<tbody>`, for the infobox's facts table.
 */
export function OwnFactRows({ facts, ownersTitle }: { facts: PageFacts; ownersTitle: string }) {
  const groups: [string, FactLine[]][] = [
    [`From ${ownersTitle}`, facts.owners],
    ['From the community', facts.community],
  ];
  return groups
    .filter(([, rows]) => rows.length > 0)
    .map(([title, rows]) => (
      <Fragment key={title}>
        <tr>
          <td colSpan={2} className={`${ui.fine} !pt-3 !pb-0.5`}>
            {title}
          </td>
        </tr>
        {rows.map((row, i) => (
          <tr key={i}>
            <th scope="row" className="!whitespace-normal">
              {row.label}
            </th>
            <td>
              {row.url ? (
                <a href={row.url} rel="nofollow noopener" className="text-accent">
                  {row.value}
                </a>
              ) : (
                row.value
              )}
            </td>
          </tr>
        ))}
      </Fragment>
    ));
}

/** "Add a row" under an infobox's facts: a prompt for the reader's agent, or the page's files. */
export function AddFactRow({ pagePath }: { pagePath: string }) {
  return (
    // A div: the choice it opens is a <dialog>, which a <p> can't hold.
    <div className="mt-2 text-xs">
      <AddMissing what="fact" paperPath={pagePath} words={{ question: '', action: 'Add a row' }} />
    </div>
  );
}
