'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { SearchIcon } from '@/components/icons';
import { type SettingsPage, SettingsList, useSettingItems } from '@/components/settings/SettingsList';
import { ui } from '@/components/ui';
import { checkSettings, formatProblem, isEditable, parseSettings } from '@/lib/settings';
import { SettingsError, saveSettings, useSettings } from '@/lib/settings/client';
import { matchesSearch } from '@/lib/settings/form';

type Note = { ok: boolean; text: string } | null;

/**
 * `/settings`'s frame, as VS Code's settings editor: a search over every setting, the pages down the side (the core
 * categories, the account's, and one per installed plugin), and the reader's settings.json to download and upload.
 * The page beside it is the category or plugin chosen; while a search is typed, its results take the page's place.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const settings = useSettings();
  const { items, pages, signedIn } = useSettingItems();
  const [query, setQuery] = useState('');
  const [note, setNote] = useState<Note>(null);
  const searchField = useRef<HTMLInputElement>(null);

  // Choosing a page leaves the search.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setQuery('');
  }

  useEffect(() => {
    // Cmd/Ctrl+F searches the settings, as in VS Code, when the search field isn't already focused.
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && document.activeElement !== searchField.current) {
        e.preventDefault();
        searchField.current?.focus();
        searchField.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pageById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const results = useMemo(
    () => (query.trim() ? items.filter((i) => matchesSearch(i, pageById.get(i.category)?.title ?? '', query)) : []),
    [items, query, pageById],
  );
  const modified = useMemo(() => Object.keys(parseSettings(settings.text)).length, [settings.text]);

  return (
    <div className="font-sans text-sm">
      <div className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h1 className="font-serif text-[26px] font-normal">Settings</h1>
        <span className="flex-1" />
        <FileActions onNote={setNote} />
      </div>
      <p className={`${ui.fine} mt-0 mb-4`}>
        {!settings.loaded
          ? 'Loading…'
          : `${signedIn ? 'Kept with your account' : 'Kept in this browser until you sign in'} · ${
              modified === 0 ? 'all defaults' : `${modified} changed from the defaults`
            } · saved as you change them`}
      </p>
      {note && <p className={`${ui.note(note.ok)} mb-3 whitespace-pre-line`}>{note.text}</p>}

      <label className="relative mb-6 block">
        <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint">
          <SearchIcon />
        </span>
        <input
          ref={searchField}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          placeholder="Search settings"
          aria-label="Search settings"
          className="w-full border border-rule bg-card py-2 pr-3 pl-8 text-sm leading-[normal] placeholder:text-faint focus:border-frame focus:outline-none narrow:text-base"
        />
      </label>

      <div className="grid grid-cols-[190px_minmax(0,1fr)] gap-10 narrow:grid-cols-1 narrow:gap-4">
        <Sidebar pages={pages} pathname={pathname} query={query} results={results.map((r) => r.category)} />
        <div className="min-w-0">
          {query.trim() ? (
            <>
              <h2 className="mb-2 font-serif text-xl font-normal">
                {results.length === 0
                  ? `Nothing matches “${query.trim()}”`
                  : `${results.length} setting${results.length === 1 ? '' : 's'} match “${query.trim()}”`}
              </h2>
              <div className="pl-4">
                <SettingsList items={results} pageOf={(item) => pageById.get(item.category)} />
              </div>
            </>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}

const SECTIONS: SettingsPage['section'][] = ['Pages', 'Account', 'Plugins'];

function Sidebar({
  pages,
  pathname,
  query,
  results,
}: {
  pages: SettingsPage[];
  pathname: string;
  query: string;
  /** The page of each search result, to count them by page. */
  results: string[];
}) {
  const searching = query.trim() !== '';
  const link = (href: string, title: ReactNode, key: string, count?: number, mark?: ReactNode) => {
    const on = !searching && (pathname === href || (href !== '/settings/plugins' && pathname.startsWith(`${href}/`)));
    return (
      <li key={key}>
        <Link
          href={href}
          aria-current={on ? 'page' : undefined}
          className={`-ml-2.5 flex items-baseline gap-2 border-l-2 py-1 pl-2 hover:no-underline ${
            on ? 'border-accent font-semibold text-ink' : 'border-transparent text-subtle hover:text-ink'
          } ${searching && !count ? 'opacity-40' : ''}`}
        >
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {mark}
          {searching && count ? <span className="text-xs text-faint tabular-nums">{count}</span> : null}
        </Link>
      </li>
    );
  };
  const count = (id: string) => results.filter((r) => r === id).length;
  return (
    <nav aria-label="Settings" className="narrow:border-b narrow:border-rule narrow:pb-3">
      {SECTIONS.map((section) => {
        const list = pages.filter((p) => p.section === section);
        return (
          <div key={section} className="mb-5 narrow:mb-3">
            <h2 className="mb-1 text-xs tracking-wide text-faint uppercase">{section}</h2>
            <ul className="ml-2.5 narrow:flex narrow:flex-wrap narrow:gap-x-4">
              {list.map((p) =>
                link(
                  p.href,
                  p.title,
                  p.id,
                  count(p.id),
                  p.plugin?.status === 'consent' ? (
                    <span title="Waits for your approval" className="size-1.5 self-center rounded-full bg-accent" />
                  ) : p.plugin && p.plugin.status !== 'ready' ? (
                    <span className="text-xs text-faint">off</span>
                  ) : null,
                ),
              )}
              {section === 'Account' && link('/profile', 'Profile, email and keys ↗', 'profile')}
              {section === 'Plugins' &&
                link('/settings/plugins', <span className="text-accent">Manage plugins…</span>, 'manage')}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** Download the reader's settings.json, or upload one to replace it after a look at what it says. */
function FileActions({ onNote }: { onNote: (n: Note) => void }) {
  const settings = useSettings();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ name: string; text: string; count: number; warnings: number } | null>(null);
  const [busy, setBusy] = useState(false);

  function download() {
    const url = URL.createObjectURL(new Blob([settings.text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'settings.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function read(file: File) {
    onNote(null);
    setPending(null);
    const text = await file.text();
    if (!isEditable(text)) {
      onNote({
        ok: false,
        text: `${file.name} isn't a settings.json: it must be one JSON object (comments are fine).`,
      });
      return;
    }
    const problems = checkSettings(text, settings.plugins);
    const errors = problems.filter((p) => p.severity === 'error');
    if (errors.length) {
      onNote({
        ok: false,
        text: `${file.name} wasn't uploaded. Fix these and upload it again:\n${errors.map((p) => `line ${p.line}: ${formatProblem(p)}`).join('\n')}`,
      });
      return;
    }
    setPending({ name: file.name, text, count: Object.keys(parseSettings(text)).length, warnings: problems.length });
  }

  async function replace() {
    if (!pending) return;
    setBusy(true);
    try {
      const warnings = await saveSettings(pending.text);
      onNote({
        ok: true,
        text: `Your settings are now ${pending.name}.${
          warnings.length ? `\n${warnings.map((p) => `line ${p.line}: ${formatProblem(p)}`).join('\n')}` : ''
        }`,
      });
      setPending(null);
    } catch (err) {
      onNote({ ok: false, text: err instanceof SettingsError ? err.message : 'Could not save your settings.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <button className={ui.linkBtn} disabled={!settings.loaded} onClick={download}>
        Download settings.json
      </button>
      <button className={ui.linkBtn} disabled={!settings.loaded} onClick={() => fileInput.current?.click()}>
        Upload…
      </button>
      <a href="/schemas/settings.json" className="text-muted" title="Its JSON Schema, for your editor">
        Schema
      </a>
      <input
        ref={fileInput}
        type="file"
        accept=".json,.jsonc,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void read(file);
        }}
      />
      {pending && (
        <div
          className={`${ui.box} absolute top-full right-0 z-10 mt-2 w-[min(420px,calc(100vw-32px))] shadow-md`}
          role="alertdialog"
          aria-label="Replace your settings?"
        >
          <p>
            Replace your settings with <b>{pending.name}</b>? It sets {pending.count} setting
            {pending.count === 1 ? '' : 's'}
            {pending.warnings ? `, with ${pending.warnings} warning${pending.warnings === 1 ? '' : 's'}` : ''}. What
            your current file says is replaced; download it first to keep a copy.
          </p>
          <div className="mt-2 flex gap-4">
            <button className={ui.btn({ inline: true, flush: true })} disabled={busy} onClick={replace}>
              Replace
            </button>
            <button className={ui.linkBtn} disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
