'use client';

import { useState, type FormEvent } from 'react';
import { ui } from '@/components/ui';
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

export function SectionEditor({ paper, pagePath, baseOid, section, initial, starter }: Props) {
  const [text, setText] = useState(initial);
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
        body: JSON.stringify({ paper, baseOid: base.oid, section: base.section, content: text, summary }),
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
      const anchor = base.section > 0 ? `#community-${base.section}` : '#community';
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
                <div dangerouslySetInnerHTML={{ __html: preview }} />
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
        Markdown, with <code>$…$</code> and <code>$$…$$</code> for math. HTML is shown as text.
      </p>
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
