'use client';

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { DemoFrames } from '@/components/paper/DemoFrames';
import { ui } from '@/components/ui';
import { demoBlockMarkdown, MAX_DEMO_DESCRIPTION, MAX_DEMO_TITLE } from '@/lib/demos';
import type { PaperId } from '@/lib/paper-ids';
import { closeEditor, messageOf, reloadAt, useEditing, useOpened, type SectionOpened } from './editing';
import { EditorFrame, NotOpened } from './EditorFrame';
import { PreviewHtml } from './PreviewHtml';

/**
 * The author or community section, as the page renders it, which turns into its editor in place: the whole
 * part (`#edit-community`) or one of its sections (`#edit-community-2`), the rest of the page around it
 * as it was. Markdown on the left, and on the right the section as it will look, rendered as you type.
 */

interface Props {
  paper: PaperId;
  part: 'author' | 'community';
  /** The stored HTML, with the headings' edit links; `null` when the part is empty. */
  html: string | null;
  /** What the page shows when the part is empty. */
  empty: ReactNode;
  claimPath: string;
}

/** The HTML before the first section, then each section's, at the headings the renderer marked. */
function chunksOf(html: string): string[] {
  const chunks = html.split(/(?=<h3 [^>]*data-section=")/);
  return /^<h3 [^>]*data-section="/.test(chunks[0] ?? '') ? ['', ...chunks] : chunks;
}

const withoutEditLinks = (html: string) => html.replace(/<a class="section-edit"[^>]*>[^<]*<\/a>/g, '');

function sectionOf(target: string, part: string): number | null {
  if (target === part) return 0;
  const match = new RegExp(`^${part}-(\\d+)$`).exec(target);
  return match ? Number(match[1]) : null;
}

export function EditableSection({ paper, part, html, empty, claimPath }: Props) {
  const [dirty, setDirty] = useState(false);
  const active = useEditing((target) => sectionOf(target, part) !== null, dirty);
  const section = active === null ? null : sectionOf(active, part);
  if (section === null) return html ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} /> : empty;

  const chunks = html ? chunksOf(html) : [];
  const editing = section === 0 || section >= chunks.length ? null : section;
  const before = editing === null ? [] : chunks.slice(0, editing);
  const after = editing === null ? [] : chunks.slice(editing + 1);
  const shown = editing === null ? (html ?? '') : chunks[editing];
  return (
    <>
      {before.map((chunk, i) => (
        <div key={i} className="md" dangerouslySetInnerHTML={{ __html: chunk }} />
      ))}
      <SectionEditor
        // A new target is a new editor, with its own text.
        key={active}
        paper={paper}
        part={part}
        section={section}
        shown={withoutEditLinks(shown)}
        claimPath={claimPath}
        onDirty={setDirty}
      />
      {after.map((chunk, i) => (
        <div key={i} className="md" dangerouslySetInnerHTML={{ __html: chunk }} />
      ))}
    </>
  );
}

interface EditorProps {
  paper: PaperId;
  part: 'author' | 'community';
  section: number;
  /** The section as the page shows it now, the preview's first look. */
  shown: string;
  claimPath: string;
  onDirty: (dirty: boolean) => void;
}

function SectionEditor({ paper, part, section, shown, claimPath, onDirty }: EditorProps) {
  const opening = useOpened<SectionOpened>(paper, part, section);
  const label = `Editing the ${part} section${section > 0 ? `, section ${section}` : ''}`;
  return (
    <EditorFrame label={label}>
      {opening.status === 'ready' ? (
        <SectionForm paper={paper} opened={opening.data} shown={shown} onDirty={onDirty} />
      ) : (
        <NotOpened opening={opening} claimPath={claimPath} />
      )}
    </EditorFrame>
  );
}

interface Conflict {
  head: string | null;
  section: number;
  text: string;
}

async function errorOf(res: Response): Promise<{ message: string; conflict: Conflict | null }> {
  if (res.status === 401) return { message: await messageOf(res), conflict: null };
  const body = await res.json().catch(() => null);
  const error = body?.error;
  const current = error?.code === 'edit_conflict' ? error.details?.current : null;
  return {
    message: error?.message ?? `Something went wrong (${res.status}).`,
    conflict: current ? { head: current.head ?? null, section: current.section ?? 0, text: current.text ?? '' } : null,
  };
}

const PREVIEW_DELAY_MS = 300;

/**
 * The Markdown and its preview. If someone changed the same lines meanwhile, the text stays, the current
 * version shows under it, and the next save is made against that version.
 */
function SectionForm({
  paper,
  opened,
  shown,
  onDirty,
}: {
  paper: PaperId;
  opened: SectionOpened;
  shown: string;
  onDirty: (dirty: boolean) => void;
}) {
  const { part, starter } = opened;
  const [text, setText] = useState(opened.text);
  const [summary, setSummary] = useState('');
  const [base, setBase] = useState({ oid: opened.baseOid, section: opened.section });
  const [preview, setPreview] = useState<string>(starter ? '' : shown);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const cursor = useRef<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<ViewMode>('split');

  const dirty = text !== opened.text;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  // As tall as its text, so that it and the preview scroll with the page, side by side. Hidden, it has no
  // height to measure, so it is measured again once it shows.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight + 2, 160)}px`;
  }, [text, mode]);

  // The preview, through the server's renderer: the same HTML a commit stores.
  useEffect(() => {
    if (text === opened.text && !starter) return;
    const timer = setTimeout(async () => {
      const res = await fetch('/api/v1/pages/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      }).catch(() => null);
      if (res?.ok) setPreview((await res.json()).html);
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, opened.text, starter]);

  /** Puts the demo's block where the cursor was, on lines of its own. */
  function insertBlock(block: string) {
    setText((current) => {
      const at = Math.min(cursor.current ?? current.length, current.length);
      const before = current.slice(0, at);
      const after = current.slice(at);
      const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      const trail = after === '' || after.startsWith('\n') ? '' : '\n';
      return `${before}${lead}${block}${trail}${after}`;
    });
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
      onDirty(false);
      reloadAt(head, base.section > 0 ? `#${part}-${base.section}` : `#${part}`);
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    if (dirty && !window.confirm('Throw away your changes?')) return;
    onDirty(false);
    closeEditor();
  }

  /** Saves the next time against the version shown, so that what is saved is what was seen. */
  function adoptCurrent() {
    if (!conflict) return;
    setBase({ oid: conflict.head, section: conflict.section });
    setConflict(null);
    setProblem(null);
  }

  return (
    <form onSubmit={save}>
      {starter && (
        <p className="mb-2 text-xs text-faint">
          Nothing is written here yet. The headings are a start: keep the ones you fill in, and delete the rest.
        </p>
      )}
      <ViewModes mode={mode} onChange={setMode} />
      <div className={`grid items-start gap-4 ${mode === 'split' ? 'grid-cols-2 narrow:grid-cols-1' : 'grid-cols-1'}`}>
        {/* Hidden rather than gone, so that a demo in the preview keeps running across a switch. */}
        <div hidden={mode === 'preview'}>
          <textarea
            ref={area}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onSelect={(event) => {
              cursor.current = event.currentTarget.selectionStart;
            }}
            spellCheck
            autoFocus
            aria-label="Markdown"
            className={`${ui.input} resize-none overflow-hidden font-mono text-[13px] leading-relaxed`}
          />
        </div>
        {/* The page's own type, so this reads as the section it replaces. */}
        <div hidden={mode === 'markdown'} className="md min-h-40 font-serif text-[15px]">
          {preview ? (
            <>
              <PreviewHtml html={preview} />
              <DemoFrames watch={preview} />
            </>
          ) : (
            <p className="text-muted italic">Nothing yet.</p>
          )}
        </div>
      </div>
      {conflict && (
        <div className="mt-4 border-t border-rule pt-3">
          <h2 className={ui.runIn}>The current version</h2>
          <textarea
            value={conflict.text}
            readOnly
            rows={12}
            aria-label="The current version"
            className={`${ui.input} mt-2 bg-tint font-mono text-[13px]`}
          />
          <p className={ui.fine}>
            {conflict.section === 0 && opened.section !== 0
              ? 'The section is gone, so this is the whole section. Saving now replaces all of it.'
              : 'Copy what you need from here into your text.'}
          </p>
          <button type="button" className={ui.btn({ inline: true, ghost: true })} onClick={adoptCurrent}>
            I&apos;ve merged them: save against this version
          </button>
        </div>
      )}
      <p className={ui.fine}>
        Markdown, with <code>$…$</code> and <code>$$…$$</code> for math. HTML is shown as text. A demo is a{' '}
        <code>```demo</code> block: insert one below.
      </p>
      <InsertDemo onInsert={insertBlock} />
      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <input
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          maxLength={300}
          placeholder="Summary of the change (optional)"
          aria-label="Summary of the change"
          className={`${ui.input} max-w-96 flex-1`}
        />
        <button type="submit" disabled={busy || conflict !== null} className={ui.btn({ inline: true, flush: true })}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={cancel} className={ui.linkBtn}>
          Cancel
        </button>
      </div>
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </form>
  );
}

type ViewMode = 'markdown' | 'split' | 'preview';

const VIEW_MODES: { mode: ViewMode; label: string }[] = [
  { mode: 'markdown', label: 'Markdown' },
  { mode: 'split', label: 'Split' },
  { mode: 'preview', label: 'Preview' },
];

/** The Markdown alone, it beside its preview, or the preview alone. */
function ViewModes({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div role="group" aria-label="View" className="mb-2 inline-flex border border-rule text-xs">
      {VIEW_MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          aria-pressed={mode === m.mode}
          onClick={() => onChange(m.mode)}
          className={`cursor-pointer px-2.5 py-1 not-first:border-l not-first:border-rule ${
            mode === m.mode ? 'bg-rule-soft font-semibold text-ink' : 'text-muted hover:text-ink'
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
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

  const enter = (e: React.KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), void copy());
  // Not a form of its own: it sits inside the editor's, and Enter here must not save the edit.
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-accent">Insert a demo from GitHub</summary>
      <div className="mt-2 max-w-xl">
        <label className="block">
          <span className="text-muted">GitHub repo, folder or gist</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={enter}
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
            onKeyDown={enter}
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
