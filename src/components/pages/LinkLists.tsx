import { ui } from '@/components/ui';
import { formatIdentifier, pagePath } from '@/lib/kinds';
import { LINK_LABELS } from '@/lib/labeled-links';
import type { PageLink } from '@/server/page-links';

/**
 * A page's labeled links (DESIGN.md §8), as a side box: its own, read from its side ("extends"), or the links to
 * it, "what links here", read from the target's ("extended by"). Grouped by label; each says who asserts it when
 * that is the page's owners. The same on every kind of page.
 */
export function LinksBox({ links, direction }: { links: PageLink[]; direction: 'from' | 'to' }) {
  if (links.length === 0) return null;
  const groups = new Map<string, PageLink[]>();
  for (const link of links) {
    const label = LINK_LABELS[link.label];
    const words = direction === 'from' ? label.reads : label.inverse;
    groups.set(words, [...(groups.get(words) ?? []), link]);
  }
  return (
    <div className={ui.box}>
      <h2 className={ui.boxHeading}>{direction === 'from' ? 'Links' : 'What links here'}</h2>
      {[...groups].map(([words, group]) => (
        <div key={words} className="mb-2 last:mb-0">
          <div className="text-xs text-muted">{words.charAt(0).toUpperCase() + words.slice(1)}</div>
          <ul className="space-y-1">
            {group.map((link, i) => (
              <li key={i}>
                <LinkedName link={link} />
                {link.origin === 'owners' && <span className={ui.badge}>owners</span>}
                {link.note && <div className="text-xs text-subtle">{link.note}</div>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function LinkedName({ link }: { link: PageLink }) {
  const { address, name } = link.page;
  const shown = name ?? (address ? formatIdentifier(address) : 'a page');
  if (!address) return <span className="text-ink">{shown}</span>;
  return (
    <a href={pagePath(address)} className={name ? 'text-ink' : 'text-muted italic'}>
      {shown}
    </a>
  );
}
