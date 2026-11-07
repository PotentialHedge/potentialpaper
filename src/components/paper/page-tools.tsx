import { notFound, redirect } from 'next/navigation';
import { ui } from '@/components/ui';
import {
  canonicalPaperId,
  PATH_PREFIX,
  paperPath,
  parsePaperId,
  type PaperId,
  type PaperScheme,
} from '@/lib/paper-ids';
import { findPaper, type FoundPaper } from '@/server/papers';

/**
 * What the edit, history and diff pages share. Each lives at its own prefix in front of the paper's
 * address (`/history/abs/1706.03762`), since the paper routes are catch-alls that end anywhere. They are
 * dynamic, never cached, and kept out of indexes.
 */

export type ToolParams = Promise<{ scheme: string; value: string[] }>;
export type ToolSearchParams = Promise<Record<string, string | string[] | undefined>>;
export type Tool = 'edit' | 'history' | 'diff';

const SCHEME_OF_PREFIX = Object.fromEntries(
  Object.entries(PATH_PREFIX).map(([scheme, prefix]) => [prefix.slice(1), scheme as PaperScheme]),
) as Record<string, PaperScheme>;

export interface ToolPaper extends FoundPaper {
  /** The identifier the page was asked by, which its links keep. */
  id: PaperId;
  /** The identifier the API is called with. */
  canonical: PaperId;
}

/** The paper behind a tool page's address. A duplicate's address redirects to the paper's own. */
export async function toolPaper(tool: Tool, params: ToolParams, query = ''): Promise<ToolPaper> {
  const { scheme, value } = await params;
  const known = SCHEME_OF_PREFIX[scheme];
  let raw: string;
  try {
    raw = value.map(decodeURIComponent).join('/');
  } catch {
    notFound();
  }
  const id = known && parsePaperId(known, raw);
  const found = id && (await findPaper(id));
  if (!id || !found) notFound();
  const canonical = canonicalPaperId(found.identifiers) ?? id;
  if (found.merged) redirect(toolPath(tool, canonical, query));
  return { ...found, id, canonical };
}

export function toolPath(tool: Tool, id: PaperId, query = ''): string {
  return `/${tool}${paperPath(id)}${query ? `?${query}` : ''}`;
}

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The paper's title, linked back to its page, and the tool's links. */
export function ToolHeader({ paper, tool, title }: { paper: ToolPaper; tool: Tool; title: string }) {
  const links: { tool: Tool | 'page'; label: string; href: string }[] = [
    { tool: 'page', label: 'Page', href: paperPath(paper.id) },
    { tool: 'edit', label: 'Edit', href: toolPath('edit', paper.id) },
    { tool: 'history', label: 'History', href: toolPath('history', paper.id) },
  ];
  return (
    <header className="mt-6">
      <p className={`${ui.fine} font-sans`}>
        <a href={paperPath(paper.id)}>{paper.paper.title}</a>
      </p>
      <h1 className="mt-1 text-[26px] leading-tight font-normal">{title}</h1>
      <nav className="mt-2 flex gap-3 font-sans text-sm">
        {links.map((link) => (
          <a key={link.tool} href={link.href} className={link.tool === tool ? ui.on : undefined}>
            {link.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
