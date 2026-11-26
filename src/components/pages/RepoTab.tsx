'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { languageOf, useHighlight } from '@/components/highlight';
import { FileIcon, FolderIcon, PencilIcon, WITH_ICON } from '@/components/icons';
import { ui } from '@/components/ui';
import { ago } from '@/lib/ago';
import { type PageAddress, pageRefOf } from '@/lib/kinds';
import { toolPath } from '@/lib/page-tools';
import { track } from '@/lib/track';
import { OPEN_EDIT } from './EditDialog';

/**
 * A page's Repo tab: its git repository as GitHub's file browser shows one, from `GET /api/v1/repo` (a folder at a
 * time, `server/pages/browse.ts`) and `/api/v1/repo/file`. Loaded only when the tab opens, so the page itself stays
 * the same cached HTML.
 *
 * Where the reader is lives in the address's hash, `#repo`, `#repo/tree/<folder>`, `#repo/blob/<file>`: links to a
 * folder or file can be shared, open the tab (`ArrangedTabs`), and the back button walks back through them. A hash,
 * not a query, so the page's address, which the edge caches, never changes.
 */

export const REPO_HASH = '#repo';

type Where = { type: 'tree' | 'blob'; path: string };

/** Where a hash points, or `null` for a hash that isn't the Repo tab's. */
export function repoWhere(hash: string): Where | null {
  if (hash !== REPO_HASH && !hash.startsWith(`${REPO_HASH}/`)) return null;
  const m = /^#repo\/(tree|blob)\/(.+)$/.exec(hash);
  if (!m) return { type: 'tree', path: '' };
  let path: string;
  try {
    path = decodeURIComponent(m[2]);
  } catch {
    return { type: 'tree', path: '' };
  }
  return { type: m[1] as Where['type'], path };
}

function hashOf({ type, path }: Where): string {
  if (type === 'tree' && path === '') return REPO_HASH;
  return `${REPO_HASH}/${type}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

interface Commit {
  oid: string;
  seq: number;
  summary: string;
  authorId: string;
  handle: string | null;
  authorName: string | null;
  at: string;
}

interface Entry {
  name: string;
  path: string;
  type: 'folder' | 'file';
  bytes: number | null;
  lfs: boolean;
  last: { oid: string; summary: string; at: string } | null;
}

interface Folder {
  placeholder: boolean;
  head: Commit | null;
  commits: number;
  path: string;
  entries: Entry[];
  readme: { path: string; html: string } | null;
}

type FileView =
  | { type: 'markdown'; html: string }
  | { type: 'text'; text: string }
  | { type: 'lfs'; kind: 'pdf' | 'image'; sha256: string; bytes: number; url: string | null }
  | { type: 'binary' }
  | { type: 'large' };

interface RepoFile {
  placeholder: boolean;
  path: string;
  oid: string;
  bytes: number;
  view: FileView;
}

type Loaded<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'done'; data: T };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `the repository could not be read (${res.status})`);
  return body as T;
}

/** A file's size as a listing shows it. */
function size(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What an opened file shows as, for `repo_file_opened`: our own words, never its path. */
function fileTarget(path: string, view: FileView): string {
  if (view.type === 'lfs') return view.kind;
  if (/(^|\/)readme\.md$/i.test(path)) return 'readme';
  if (view.type === 'markdown') return /^[a-z]+\/\d\d-/.test(path) ? 'section' : 'markdown';
  if (/\.jsonl?$/.test(path)) return 'json';
  return view.type === 'text' ? 'text' : 'other';
}

export function RepoTab({ address }: { address: PageAddress }) {
  const [where, setWhere] = useState<Where>(() =>
    typeof window === 'undefined'
      ? { type: 'tree', path: '' }
      : (repoWhere(window.location.hash) ?? { type: 'tree', path: '' }),
  );
  // The folder's listing, the commit and the README come with every folder; the header keeps the last one it had
  // while a file is shown. Each answer is kept with the place it is for, so a place without one is loading.
  const [folder, setFolder] = useState<{ for: string; loaded: Loaded<Folder> } | null>(null);
  const [file, setFile] = useState<{ for: string; loaded: Loaded<RepoFile> } | null>(null);
  const [head, setHead] = useState<Folder | null>(null);
  const ref = pageRefOf(address);
  const at = hashOf(where);

  useEffect(() => {
    const onHash = () => {
      const next = repoWhere(window.location.hash);
      if (next) setWhere(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const needsHead = head === null;
  useEffect(() => {
    let live = true;
    const query = (path: string) => new URLSearchParams({ scheme: ref.scheme, value: ref.value, path }).toString();
    const failed = (err: Error): Loaded<never> => ({ state: 'error', message: err.message });
    if (where.type === 'tree') {
      getJson<Folder>(`/api/v1/repo?${query(where.path)}`).then(
        (data) => {
          if (!live) return;
          setFolder({ for: at, loaded: { state: 'done', data } });
          setHead(data);
        },
        (err: Error) => live && setFolder({ for: at, loaded: failed(err) }),
      );
    } else {
      getJson<RepoFile>(`/api/v1/repo/file?${query(where.path)}`).then(
        (data) => {
          if (!live) return;
          setFile({ for: at, loaded: { state: 'done', data } });
          track('repo_file_opened', { target: fileTarget(data.path, data.view) });
        },
        (err: Error) => live && setFile({ for: at, loaded: failed(err) }),
      );
      // The header, for a file opened straight from a link.
      if (needsHead) {
        getJson<Folder>(`/api/v1/repo?${query('')}`).then(
          (data) => live && setHead(data),
          () => {},
        );
      }
    }
    return () => {
      live = false;
    };
    // `needsHead` is read, not watched: only where the reader is decides what to load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, where.type, where.path, ref.scheme, ref.value]);
  const loading: Loaded<never> = { state: 'loading' };
  const folderShown = folder?.for === at ? folder.loaded : loading;
  const fileShown = file?.for === at ? file.loaded : loading;

  const codePath = (path?: string) => toolPath('code', address, path ? `file=${encodeURIComponent(path)}` : '');
  const diffPath = (oid: string) => toolPath('diff', address, `oid=${oid}`);
  const go = (to: Where) => hashOf(to);

  return (
    <div className="font-sans text-sm">
      <Header folder={head} address={address} diffPath={diffPath} />
      <Crumbs where={where} go={go} />
      {where.type === 'tree' ? (
        <FolderView loaded={folderShown} go={go} diffPath={diffPath} />
      ) : (
        <FileShown loaded={fileShown} codePath={codePath} address={address} />
      )}
    </div>
  );
}

function Header({
  folder,
  address,
  diffPath,
}: {
  folder: Folder | null;
  address: PageAddress;
  diffPath: (oid: string) => string;
}) {
  const head = folder?.head;
  const who = head ? (head.authorName ?? (head.handle ? `@${head.handle}` : 'potentialpaper')) : null;
  return (
    <div className="flex items-stretch gap-3 narrow:flex-col">
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1 border border-frame bg-card px-3 py-2 text-[13px]">
        {head ? (
          <span className="min-w-0 flex-1 basis-64 truncate">
            <span className="text-ink">{who}</span>{' '}
            <a href={diffPath(head.oid)} className="text-subtle hover:text-accent" title={head.summary}>
              {head.summary}
            </a>
          </span>
        ) : (
          <span className="min-w-0 flex-1 basis-64 text-muted">{folder ? 'No commits yet' : 'Loading…'}</span>
        )}
        {head && (
          <span className="text-faint">
            <a href={diffPath(head.oid)} className={`${ui.mono} text-faint hover:text-accent`}>
              {head.oid.slice(0, 7)}
            </a>
            {' · '}
            <span title={new Date(head.at).toISOString().slice(0, 16).replace('T', ' ')}>{ago(head.at)}</span>
          </span>
        )}
        {folder && !folder.placeholder && (
          <a href={toolPath('history', address)} className="text-accent">
            {folder.commits} commit{folder.commits === 1 ? '' : 's'}
          </a>
        )}
      </div>
      {/* The Edit dialog under the title (`EditDialog`): the web editor, the clone command and the agent's prompt. */}
      <button
        type="button"
        className={`${ui.btn({ inline: true, flush: true })} ${WITH_ICON} justify-center`}
        onClick={() => window.dispatchEvent(new Event(OPEN_EDIT))}
      >
        <PencilIcon />
        Clone or edit
      </button>
    </div>
  );
}

/** The path from the repo's top down to where the reader is, each part a link but the last. */
function Crumbs({ where, go }: { where: Where; go: (to: Where) => string }) {
  const parts = where.path ? where.path.split('/') : [];
  return (
    <nav aria-label="Folder" className={`mt-3 ${ui.mono} break-all`}>
      {parts.length === 0 ? (
        <span className="font-semibold text-ink">repo</span>
      ) : (
        <a href={go({ type: 'tree', path: '' })} className="text-accent">
          repo
        </a>
      )}
      {parts.map((name, i) => {
        const last = i === parts.length - 1;
        return (
          <Fragment key={i}>
            <span className="mx-1 text-faint">/</span>
            {last ? (
              <span className="font-semibold text-ink">{name}</span>
            ) : (
              <a href={go({ type: 'tree', path: parts.slice(0, i + 1).join('/') })} className="text-accent">
                {name}
              </a>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

function FolderView({
  loaded,
  go,
  diffPath,
}: {
  loaded: Loaded<Folder>;
  go: (to: Where) => string;
  diffPath: (oid: string) => string;
}) {
  const readme = useRef<HTMLDivElement>(null);
  useHighlight(readme, loaded);
  if (loaded.state === 'loading') return <p className="mt-3 text-muted">Loading…</p>;
  if (loaded.state === 'error') return <p className={ui.note(false)}>{loaded.message}</p>;
  const { data } = loaded;
  const parent = data.path.includes('/') ? data.path.slice(0, data.path.lastIndexOf('/')) : '';
  return (
    <>
      <div className={`mt-2 ${ui.tableScroll}`}>
        <table className="w-full border-collapse border-y-[1.5px] border-ink text-[13px] [&>tbody>tr:hover]:bg-highlight/50">
          <tbody>
            {data.path !== '' && (
              <tr className="border-b border-rule-soft">
                <td colSpan={4} className="py-1.5 pr-2">
                  <a href={go({ type: 'tree', path: parent })} className={`${ui.mono} text-accent`}>
                    ..
                  </a>
                </td>
              </tr>
            )}
            {data.entries.map((e) => (
              <tr key={e.path} className="border-b border-rule-soft align-baseline">
                <td className="w-[40%] max-w-0 py-1.5 pr-3">
                  <a
                    href={go({ type: e.type === 'folder' ? 'tree' : 'blob', path: e.path })}
                    onClick={() => {
                      if (e.type === 'folder') track('repo_folder_opened', { step: e.path.split('/').length });
                    }}
                    className="inline-flex max-w-full items-center gap-1.5 text-ink hover:text-accent"
                  >
                    {e.type === 'folder' ? (
                      <FolderIcon className="size-3.5 shrink-0 text-muted" />
                    ) : (
                      <FileIcon className="size-3.5 shrink-0 text-faint" />
                    )}
                    <span className={`${ui.mono} truncate`}>{e.name}</span>
                  </a>
                  {e.lfs && <span className={ui.badge}>LFS</span>}
                </td>
                <td className="max-w-0 truncate py-1.5 pr-3 text-subtle narrow:hidden">
                  {e.last && (
                    <a href={diffPath(e.last.oid)} title={e.last.summary} className="text-subtle hover:text-accent">
                      {e.last.summary}
                    </a>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-right whitespace-nowrap text-faint">
                  {e.last && (
                    <span title={new Date(e.last.at).toISOString().slice(0, 16).replace('T', ' ')}>
                      {ago(e.last.at)}
                    </span>
                  )}
                </td>
                <td className={`py-1.5 text-right whitespace-nowrap text-faint ${ui.mono}`}>{size(e.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.entries.length === 0 && <p className={ui.empty}>This folder is empty.</p>}
      </div>
      {data.readme && (
        <div ref={readme} className="mt-6 border border-frame bg-card">
          <p className={`border-b border-rule px-3 py-1.5 ${ui.mono} text-subtle`}>
            {data.readme.path.split('/').pop()}
          </p>
          <div className="md px-5 py-4 font-serif text-[15px]" dangerouslySetInnerHTML={{ __html: data.readme.html }} />
        </div>
      )}
    </>
  );
}

function FileShown({
  loaded,
  codePath,
  address,
}: {
  loaded: Loaded<RepoFile>;
  codePath: (path?: string) => string;
  address: PageAddress;
}) {
  const shown = useRef<HTMLDivElement>(null);
  useHighlight(shown, loaded);
  if (loaded.state === 'loading') return <p className="mt-3 text-muted">Loading…</p>;
  if (loaded.state === 'error') return <p className={ui.note(false)}>{loaded.message}</p>;
  const { data } = loaded;
  const { view } = data;
  const ref = pageRefOf(address);
  const shownBytes = view.type === 'lfs' ? view.bytes : data.bytes;
  return (
    <div ref={shown} className="mt-2 border border-frame bg-card">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule px-3 py-1.5 text-[13px]">
        <span className={`${ui.mono} text-ink`}>{data.path.split('/').pop()}</span>
        <span className="text-faint">
          {size(shownBytes)}
          {view.type === 'lfs' && ' · Git LFS'}
        </span>
        <span className="flex-1" />
        {!data.placeholder && view.type !== 'lfs' && (
          <a
            href={`/api/v1/workspace/blob?${new URLSearchParams({ scheme: ref.scheme, value: ref.value, oid: data.oid })}`}
            className="text-accent"
            rel="nofollow"
          >
            download
          </a>
        )}
        <a href={codePath(data.path)} rel="nofollow" className="text-accent" onClick={() => track('repo_edit_opened')}>
          edit in web editor
        </a>
      </div>
      {view.type === 'markdown' && (
        <div className="md px-5 py-4 font-serif text-[15px]" dangerouslySetInnerHTML={{ __html: view.html }} />
      )}
      {view.type === 'text' &&
        (view.text === '' ? (
          <p className="px-3 py-3 text-muted italic">
            Empty.
            {/^[a-z]+\/\d\d-/.test(data.path) &&
              ' An empty section isn\u2019t shown on the page until someone writes in it.'}
          </p>
        ) : (
          <pre className={`overflow-x-auto px-3 py-2.5 leading-snug ${ui.mono}`}>
            <code className={`language-${languageOf(data.path)}`}>{view.text}</code>
          </pre>
        ))}
      {view.type === 'lfs' &&
        (view.url ? (
          view.kind === 'image' ? (
            <div className="p-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- an uploaded picture, at its own address */}
              <img src={view.url} alt={data.path} className="mx-auto max-h-[70vh] max-w-full" />
            </div>
          ) : (
            <p className="px-3 py-3">
              <a href={view.url} target="_blank" rel="noopener noreferrer" className="text-accent">
                Open the PDF
              </a>{' '}
              <span className="text-faint">({size(view.bytes)})</span>
            </p>
          )
        ) : (
          <p className="px-3 py-3 text-muted">
            The file this points at hasn&apos;t been uploaded to the site yet (
            <span className={ui.mono}>git lfs push</span>
            ).
          </p>
        ))}
      {view.type === 'binary' && <p className="px-3 py-3 text-muted">A binary file, not shown here.</p>}
      {view.type === 'large' && <p className="px-3 py-3 text-muted">Too large to show here: download it.</p>}
    </div>
  );
}
