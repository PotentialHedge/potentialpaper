import type { ReactNode } from 'react';
import { ui } from '@/components/ui';
import { formatIdentifier, keyedPagePath, KINDS, type OrgFile } from '@/lib/kinds';
import type { OverlapPage } from '@/server/page-members';
import type { KindPanelProps } from './slots';

/**
 * An organisation's own panels (`handoffs/pages.md` Phase 4), beside the generic ones in `slots.tsx`: what it is and
 * where it sits, its departments and labs, the people who show it as their institution, and the venues and topics its
 * papers are at, by count. What they show comes from `server/org-pages.ts`'s `orgOverview`, read once by the route
 * (`page-route.tsx`); like every panel, they are the same HTML for every reader.
 */

const plural = (n: number, word: string) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;

/** The org above it (a department's institution), its ROR id and its domains. */
export function OrgAbout({ kindFile, org }: KindPanelProps) {
  const file = (kindFile ?? {}) as OrgFile;
  const facts: ReactNode[] = [];
  if (org?.parent) {
    facts.push(
      <>
        Part of <a href={keyedPagePath('org', org.parent.key)}>{org.parent.name}</a>
      </>,
    );
  }
  if (file.domains?.length) facts.push(<>Addresses at {file.domains.join(', ')}</>);
  if (file.ror) facts.push(<a href={file.ror}>ROR</a>);
  if (facts.length === 0) return null;
  return (
    <p className={`${ui.fine} text-center`}>
      {facts.map((fact, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {fact}
        </span>
      ))}
    </p>
  );
}

/** Its departments and labs, each with its papers, and how its members add one. */
export function OrgDepartments({ org, pageKey }: KindPanelProps) {
  if (!org) return null;
  const deep = pageKey.split('/').length >= KINDS.org.maxDepth;
  if (org.children.length === 0 && deep) return null;
  return (
    <section id="departments">
      <h2 className={ui.groupHeading}>Departments and labs</h2>
      {org.children.length > 0 ? (
        <ul className="space-y-1 font-sans text-sm">
          {org.children.map((child) => (
            <li key={child.key}>
              <a href={keyedPagePath('org', child.key)}>{child.name}</a>
              <span className={ui.fine}> {plural(child.papers, 'paper')}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={ui.empty}>None yet.</p>
      )}
      {!deep && (
        <p className={`${ui.fine} mt-2`}>
          <a href={`/new/org/${pageKey}`}>Add a department or lab</a> (for its verified members)
        </p>
      )}
    </section>
  );
}

/** The members who show this as their institution, by handle. */
export function OrgPeople({ org }: KindPanelProps) {
  if (!org || org.people.count === 0) return null;
  const { handles, count } = org.people;
  return (
    <div className={ui.box}>
      <h2 className={ui.boxHeading}>People</h2>
      <p className="mb-1.5 text-xs text-muted">
        {plural(count, 'member')} who show{count === 1 ? 's' : ''} it as their institution
      </p>
      <ul className="flex flex-wrap gap-x-2.5 gap-y-1">
        {handles.map((handle) => (
          <li key={handle}>
            <a href={keyedPagePath('user', handle)}>@{handle}</a>
          </li>
        ))}
      </ul>
      {handles.length < count && <p className="mt-1.5 text-xs text-muted">and {count - handles.length} more</p>}
    </div>
  );
}

/** Pages of a kind with a count each, most first: an org's venues and topics, a topic's venues and orgs. */
export function CountBox({
  title,
  kind,
  pages,
}: {
  title: string;
  kind: 'venue' | 'topic' | 'org';
  pages: OverlapPage[];
}) {
  if (pages.length === 0) return null;
  return (
    <div className={ui.box}>
      <h2 className={ui.boxHeading}>{title}</h2>
      <ul className="space-y-1">
        {pages.map((page) => (
          <li key={page.pageId} className="flex justify-between gap-2">
            <a href={keyedPagePath(kind, page.key)} title={formatIdentifier({ kind, key: page.key })}>
              {page.name}
            </a>
            <span className="text-xs text-muted tabular-nums">{page.papers.toLocaleString('en')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The venues its papers went to, by how many of its papers each has. */
export function OrgVenues({ org }: KindPanelProps) {
  return org ? <CountBox title="Venues" kind="venue" pages={org.venues} /> : null;
}

/** The topics its papers are in, by how many of its papers each has. */
export function OrgTopics({ org }: KindPanelProps) {
  return org ? <CountBox title="Topics" kind="topic" pages={org.topics} /> : null;
}
