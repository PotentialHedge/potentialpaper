'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ui } from '@/components/ui';
import type { PaperId } from '@/lib/paper-ids';
import { MAX_LINK_LABEL, MAX_LINKS, mergeLinks, type TitleLink } from '@/lib/paper-links';
import { closeEditor, messageOf, reloadAt, useEditing, useOpened, type CardOpened } from './editing';
import { EditorFrame, NotOpened } from './EditorFrame';

/**
 * The links under the title, which turn into their editor in place (`#edit-links`). The row above the
 * editor is the row as it will be, so a link named like a built-in one is seen to replace it.
 */

interface Props {
  paper: PaperId;
  /** The paper's own links, before the page's (`titleLinks` without `extra`). */
  builtIn: TitleLink[];
  /** The links as the page shows them now. */
  shown: TitleLink[];
  claimPath: string;
}

function Row({ links, children }: { links: TitleLink[]; children?: React.ReactNode }) {
  return (
    <nav
      className="mt-1.5 flex flex-wrap justify-center gap-x-3 font-sans text-[13px]"
      aria-label="The paper elsewhere"
    >
      {links.map((l, i) => (
        <a key={i} href={l.url} className="text-accent" rel="noopener noreferrer" target="_blank">
          [{l.label}]
        </a>
      ))}
      {children}
    </nav>
  );
}

export function EditableLinks({ paper, builtIn, shown, claimPath }: Props) {
  const [dirty, setDirty] = useState(false);
  const active = useEditing((target) => target === 'links', dirty);
  if (!active) {
    return (
      <Row links={shown}>
        <a href="#edit-links" rel="nofollow" className="text-faint">
          edit links
        </a>
      </Row>
    );
  }
  return <LinksEditor paper={paper} builtIn={builtIn} claimPath={claimPath} onDirty={setDirty} />;
}

function LinksEditor({
  paper,
  builtIn,
  claimPath,
  onDirty,
}: Omit<Props, 'shown'> & { onDirty: (dirty: boolean) => void }) {
  const opening = useOpened<CardOpened>(paper, 'card');
  return opening.status === 'ready' ? (
    <LinksForm
      paper={paper}
      builtIn={builtIn}
      initial={opening.data.links}
      claimed={opening.data.claimed}
      onDirty={onDirty}
    />
  ) : (
    <>
      <Row links={builtIn} />
      <EditorFrame label="Editing the links" className="mx-auto my-3 max-w-2xl">
        <NotOpened opening={opening} claimPath={claimPath} />
      </EditorFrame>
    </>
  );
}

function LinksForm({
  paper,
  builtIn,
  initial,
  claimed,
  onDirty,
}: {
  paper: PaperId;
  builtIn: TitleLink[];
  initial: TitleLink[];
  claimed: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const [rows, setRows] = useState<TitleLink[]>(initial.length > 0 ? initial : [{ label: '', url: '' }]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const filled = rows.filter((row) => row.label.trim() || row.url.trim());

  const dirty = JSON.stringify(filled) !== JSON.stringify(initial);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  function change(index: number, key: keyof TitleLink, value: string) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch('/api/v1/pages/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paper, links: filled }),
      });
      if (!res.ok) return setProblem(await messageOf(res));
      onDirty(false);
      reloadAt((await res.json()).head);
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    onDirty(false);
    closeEditor();
  }

  const preview = mergeLinks(
    builtIn,
    filled.filter((row) => row.label.trim() && row.url.trim()).map((row) => ({ ...row, label: row.label.trim() })),
  );
  return (
    <>
      <Row links={preview} />
      <EditorFrame label="Editing the links" className="mx-auto my-3 max-w-2xl">
        <form onSubmit={save}>
          <p className="mb-2 text-xs text-faint">
            After the paper&apos;s own: Code, Project page, Video, Slides, Poster. One called PDF, arXiv, OpenReview,
            DOI or Scholar replaces that link.{' '}
            {claimed
              ? 'Its confirmed authors choose these.'
              : 'Until an author claims the paper, any verified researcher can change these.'}
          </p>
          <div className="space-y-1">
            {rows.map((row, index) => (
              <div key={index} className="flex items-start gap-2">
                <input
                  value={row.label}
                  onChange={(e) => change(index, 'label', e.target.value)}
                  placeholder="Code"
                  maxLength={MAX_LINK_LABEL}
                  aria-label={`Link ${index + 1}: label`}
                  autoFocus={index === 0}
                  className={`${ui.input} max-w-36`}
                />
                <input
                  value={row.url}
                  onChange={(e) => change(index, 'url', e.target.value)}
                  placeholder="https://github.com/…"
                  type="url"
                  aria-label={`Link ${index + 1}: address`}
                  className={ui.input}
                />
                <button
                  type="button"
                  onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                  className={`${ui.linkBtn} mt-1.5`}
                  aria-label={`Remove link ${index + 1}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-4">
            {rows.length < MAX_LINKS && (
              <button
                type="button"
                onClick={() => setRows((current) => [...current, { label: '', url: '' }])}
                className={ui.linkBtn}
              >
                Add a link
              </button>
            )}
            <span className="flex-1" />
            <button type="submit" disabled={busy} className={ui.btn({ inline: true })}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={cancel} className={ui.btn({ inline: true, ghost: true })}>
              Cancel
            </button>
          </div>
          {problem && <p className={ui.note(false)}>{problem}</p>}
        </form>
      </EditorFrame>
    </>
  );
}
