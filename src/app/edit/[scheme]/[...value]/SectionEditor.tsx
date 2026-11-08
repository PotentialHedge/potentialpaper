'use client';

import { useRef, useState, type FormEvent } from 'react';
import { DemoFrames } from '@/components/paper/DemoFrames';
import { ui } from '@/components/ui';
import { demoBlockMarkdown, MAX_DEMO_DESCRIPTION, MAX_DEMO_TITLE } from '@/lib/demos';
import type { PaperId } from '@/lib/paper-ids';

/**
 * The section editor: Markdown in a textarea, a preview through the server's renderer, and a summary. If
 * someone changed the same lines meanwhile, the text stays, the current version shows beside it, and the
 * next save is made against that version.
 */

interface Conflict {
  head: string | null;
  section: number;
  text: string;
}

interface Props {
  paper: PaperId;
  part: 'author' | 'community';
  pagePath: string;
  baseOid: string | null;
  section: number;
  initial: string;
  starter: boolean;
}

async function errorOf(res: Response): Promise<{ message: string; conflict: Conflict | null }> {
  const body = await res.json().catch(() => null);
  const error = body?.error;
  if (res.status === 401)
    return { message: 'Your session ended. Sign in again in another tab, then save.', conflict: null };
  const current = error?.code === 'edit_conflict' ? error.details?.current : null;
  return {
    message: error?.message ?? `Something went wrong (${res.status}).`,
    conflict: current ? { head: current.head ?? null, section: current.section ?? 0, text: current.text ?? '' } : null,
  };
}

export function SectionEditor({ paper, part, pagePath, baseOid, section, initial, starter }: Props) {
  const [text, setText] = useState(initial);
  const cursor = useRef<number | null>(null);

  /** Puts the demo's block where the cursor was, on lines of its own. */
  function insertBlock(block: string) {
    setTab('write');
    setText((current) => {
      const at = Math.min(cursor.current ?? current.length, current.length);
      const before = current.slice(0, at);
      const after = current.slice(at);
      const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      const trail = after === '' || after.startsWith('\n') ? '' : '\n';
      return `${before}${lead}${block}${trail}${after}`;
    });
  }
  const [summary, setSummary] = useState('');
  const [base, setBase] = useState({ oid: baseOid, section });
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  async function showPreview() {
    setTab('preview');
    setPreview(null);
    const res = await fetch('/api/v1/pages/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    }).catch(() => null);
    if (!res?.ok) {
      setPreview('');
      setProblem(res ? (await errorOf(res)).message : 'Could not reach the server.');
      return;
    }
    setPreview((await res.json()).html);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch('/api/v1/pages/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paper, part, baseOid: base.oid, section: base.section, content: text, summary }),
      });
      if (!res.ok) {
        const { message, conflict } = await errorOf(res);
        if (conflict) {
          setConflict(conflict);
          setProblem('Someone else changed the same lines since you started. Your text is still here.');
        } else {
          setProblem(message);
        }
        return;
      }
      const { head } = await res.json();
      // Past every cache, which the commit has asked to drop the page but may not have yet.
      const anchor = base.section > 0 ? `#${part}-${base.section}` : `#${part}`;
      window.location.replace(`${pagePath}?v=${(head ?? Date.now().toString(16)).slice(0, 12)}${anchor}`);
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  /** Saves the next time against the version shown, so that what is saved is what was seen. */
  function adoptCurrent() {
    if (!conflict) return;
    setBase({ oid: conflict.head, section: conflict.section });
    setConflict(null);
    setProblem(null);
  }

  const tabClass = (on: boolean) => `cursor-pointer px-2 py-1 ${on ? ui.on : 'text-accent'}`;

  return (
    <form onSubmit={save} className="mt-5 font-sans text-sm">
      {starter && (
        <p className={ui.fine}>
          Nothing is written here yet. The headings are a start: keep the ones you fill in, and delete the rest.
        </p>
      )}
      <div className="mt-2 flex gap-1 border-b border-rule">
        <button type="button" className={tabClass(tab === 'write')} onClick={() => setTab('write')}>
          Write
        </button>
        <button type="button" className={tabClass(tab === 'preview')} onClick={showPreview}>
          Preview
        </button>
      </div>
      <div className={conflict ? 'grid grid-cols-2 gap-4 narrow:grid-cols-1' : ''}>
        <div>
          {conflict && <h2 className={`mt-3 ${ui.runIn}`}>Your text</h2>}
          {tab === 'write' ? (
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onSelect={(event) => {
                cursor.current = event.currentTarget.selectionStart;
              }}
              rows={conflict ? 24 : 20}
              spellCheck
              aria-label="Markdown"
              className={`${ui.input} mt-2 font-mono text-[13px]`}
            />
          ) : (
            <div className="md mt-2 min-h-40 border border-rule bg-card p-3 font-serif text-[15px]">
              {preview === null ? (
                <p className="text-muted italic">Rendering…</p>
              ) : (
                // The server's renderer, with raw HTML off: the same HTML a commit stores.
                <>
                  <div dangerouslySetInnerHTML={{ __html: preview }} />
                  <DemoFrames watch={preview} />
                </>
              )}
            </div>
          )}
        </div>
        {conflict && (
          <div>
            <h2 className={`mt-3 ${ui.runIn}`}>The current version</h2>
            <textarea
              value={conflict.text}
              readOnly
              rows={24}
              aria-label="The current version"
              className={`${ui.input} mt-2 bg-tint font-mono text-[13px]`}
            />
            <p className={ui.fine}>
              {conflict.section === 0 && section !== 0
                ? 'The section is gone, so this is the whole community section. Saving now replaces all of it.'
                : 'Copy what you need from here into your text.'}
            </p>
            <button type="button" className={ui.btn({ inline: true, ghost: true })} onClick={adoptCurrent}>
              I&apos;ve merged them: save against this version
            </button>
          </div>
        )}
      </div>
      <p className={ui.fine}>
        Markdown, with <code>$…$</code> and <code>$$…$$</code> for math. HTML is shown as text. A demo is a{' '}
        <code>```demo</code> block: insert one below.
      </p>
      <InsertDemo onInsert={insertBlock} />
      <label className="mt-3 block">
        <span className="text-muted">Summary of the change</span>
        <input
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          maxLength={300}
          placeholder="Fixed the second erratum"
          className={ui.input}
        />
      </label>
      <div className="flex items-baseline gap-4">
        <button type="submit" disabled={busy || conflict !== null} className={ui.btn({ inline: true })}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <a href={pagePath}>Cancel</a>
      </div>
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </form>
  );
}

async function messageOf(res: Response): Promise<string> {
  if (res.status === 401) return 'Your session ended. Sign in again in another tab.';
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? `Something went wrong (${res.status}).`;
}

/**
 * Copies a demo's files from GitHub, then puts its block into the text. Nothing is on the page until the
 * edit is saved, and the files stay at today's commit, so later pushes don't change it.
 */
function InsertDemo({ onInsert }: { onInsert: (block: string) => void }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function copy() {
    if (!url.trim() || !title.trim()) return setProblem('Give the address and a title.');
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch('/api/v1/demos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) return setProblem(await messageOf(res));
      const { id } = await res.json();
      onInsert(demoBlockMarkdown({ id, title, description }));
      setUrl('');
      setTitle('');
      setDescription('');
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  // Not a form of its own: it sits inside the editor's, and Enter here must not save the edit.
  return (
    <details className={`${ui.box} mt-3`}>
      <summary className="cursor-pointer font-semibold">Insert a demo from GitHub</summary>
      <div className="mt-3">
        <label className="block">
          <span className="text-muted">GitHub repo, folder or gist</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void copy())}
            type="url"
            placeholder="https://github.com/you/demo/tree/main/dist"
            className={ui.input}
          />
        </label>
        <label className="block">
          <span className="text-muted">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void copy())}
            maxLength={MAX_DEMO_TITLE}
            className={ui.input}
          />
        </label>
        <label className="block">
          <span className="text-muted">What it shows (optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={MAX_DEMO_DESCRIPTION}
            rows={2}
            className={ui.input}
          />
        </label>
        <p className={ui.fine}>
          The folder needs an <code>index.html</code> and the built files: nothing is built here. A repo with none at
          the top is searched in <code>dist</code>, <code>build</code>, <code>docs</code> and <code>public</code>. Up to
          50 MB. The files are copied at today&apos;s commit, and the block goes where your cursor was.
        </p>
        <button type="button" disabled={busy} onClick={copy} className={ui.btn({ inline: true, ghost: true })}>
          {busy ? 'Copying from GitHub…' : 'Copy and insert'}
        </button>
        {problem && <p className={ui.note(false)}>{problem}</p>}
      </div>
    </details>
  );
}
