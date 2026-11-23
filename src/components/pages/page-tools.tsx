import { notFound, redirect } from 'next/navigation';
import { ui } from '@/components/ui';
import { addressOfPath, formatIdentifier, KINDS, type PageAddress, type PageRef, pageRefOf } from '@/lib/kinds';
import { type Tool, toolPath } from '@/lib/page-tools';
import { namedPage, namedPageByShortId, type NamedPage } from '@/server/pages/named';
import type { FoundPaper } from '@/server/papers';

/** What the edit, history, diff, claim and versions pages share, for a page of any kind (`lib/page-tools.ts`). */

export type ToolParams = Promise<{ scheme: string; value: string[] }>;
export type ToolSearchParams = Promise<Record<string, string | string[] | undefined>>;

export interface ToolPage extends NamedPage {
  /** As the API is called with it. */
  ref: PageRef;
}

/**
 * The page behind a tool page's address. Any other address of it (a paper's other identifier, an old key, a page
 * merged into another) redirects to the tool at its canonical one.
 */
export async function toolPage(tool: Tool, params: ToolParams, query = ''): Promise<ToolPage> {
  const { scheme, value } = await params;
  // A paper's short address (`/history/s/42`), or any page's identifier path (`/history/abs/1706.03762`).
  const short = scheme === 's' && value.length === 1 && /^\d{1,9}$/.test(value[0]) ? Number(value[0]) : null;
  const asked = short === null ? addressOfPath(scheme, value) : null;
  const found = short !== null ? await namedPageByShortId(short) : asked && (await namedPage(asked));
  // A person's page has no files, so no history, edit or claim page (`KINDS.user.repo`).
  if (!found || !KINDS[found.address.kind].repo) notFound();
  // Any other address of it (an identifier path, an old key, a merged page) goes to its canonical one.
  const canonical = found.address.kind === 'paper' ? (found.address.shortId ?? null) : null;
  const same =
    short !== null
      ? canonical === short
      : canonical === null && asked !== null && formatIdentifier(found.address) === formatIdentifier(asked);
  if (!same) redirect(toolPath(tool, found.address, query));
  return { ...found, ref: pageRefOf(found.address) };
}

/** The same, for a tool only a paper has (`versions`). */
export async function toolPaper(
  tool: Tool,
  params: ToolParams,
  query = '',
): Promise<ToolPage & { paper: FoundPaper; address: Extract<PageAddress, { kind: 'paper' }> }> {
  const found = await toolPage(tool, params, query);
  if (!found.paper || found.address.kind !== 'paper') notFound();
  return found as ToolPage & { paper: FoundPaper; address: Extract<PageAddress, { kind: 'paper' }> };
}

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The page's name, linked back to it, and the tools' links. */
export function ToolHeader({ page, tool, title }: { page: ToolPage; tool: Tool; title: string }) {
  const links: { tool: Tool | 'page'; label: string; href: string }[] = [
    { tool: 'page', label: 'Page', href: page.path },
    { tool: 'code', label: 'Edit', href: toolPath('code', page.address) },
    { tool: 'history', label: 'History', href: toolPath('history', page.address) },
    ...(page.address.kind === 'paper'
      ? [{ tool: 'versions' as const, label: 'Versions', href: toolPath('versions', page.address) }]
      : []),
  ];
  return (
    <header className="mt-6">
      <p className={`${ui.fine} font-sans`}>
        <a href={page.path}>{page.name}</a>
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
