'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ui } from '@/components/ui';
import type { PaperId } from '@/lib/paper-ids';
import {
  formatVersionDate,
  MAX_VERSION_ABSTRACT,
  MAX_VERSION_DECISION,
  MAX_VERSION_LABEL,
  MAX_VERSION_NOTE,
  MAX_VERSION_TITLE,
  MAX_VERSIONS,
  VERSION_KIND_LABELS,
  VERSION_KINDS,
  VERSION_STATUS_LABELS,
  VERSION_STATUSES,
  versionStanding,
  type PaperVersion,
  type VersionKind,
  type VersionStatus,
} from '@/lib/versions';
import { closeEditor, messageOf, reloadAt, useEditing, useOpened, type VersionsOpened } from './editing';
import { EditorFrame, NotOpened } from './EditorFrame';
import { EvidenceInput, uploadFile } from './EvidenceInput';

/**
 * The paper's versions, which turn into their editor in place (`#edit-versions`): one card per version,
 * each with its PDF and the evidence that it is what it says, and a look-up that fills them in from
 * OpenReview and arXiv for the editor to check before saving.
 */

interface Row {
  /** The client's own key, since a new row has no id yet. */
  key: string;
  id?: string;
  label: string;
  kind: VersionKind;
  date: string;
  status: VersionStatus | '';
  decision: string;
  title: string;
  abstract: string;
  url: string;
  note: string;
  evidence: string[];
  pdf: { url: string; license?: string } | null;
  /** Open in the editor: new rows and ones being changed. */
  open: boolean;
}

let nextKey = 0;
const key = () => `row-${(nextKey += 1)}`;

function toRow(v: Partial<PaperVersion> & { label: string; kind: VersionKind }, open = false): Row {
  return {
    key: key(),
    id: v.id,
    label: v.label,
    kind: v.kind,
    date: v.date ?? '',
    status: v.status ?? '',
    decision: v.decision ?? '',
    title: v.title ?? '',
    abstract: v.abstract ?? '',
    url: v.url ?? '',
    note: v.note ?? '',
    evidence: v.evidence ?? [],
    pdf: v.pdf ? { url: v.pdf.url, ...(v.pdf.license ? { license: v.pdf.license } : {}) } : null,
    open,
  };
}

function toInput(row: Row) {
  const text = (s: string) => (s.trim() === '' ? undefined : s.trim());
  return {
    ...(row.id ? { id: row.id } : {}),
    label: row.label.trim(),
    kind: row.kind,
    date: text(row.date),
    status: row.status || undefined,
    decision: text(row.decision),
    title: text(row.title),
    abstract: text(row.abstract),
    url: text(row.url),
    note: text(row.note),
    evidence: row.evidence,
    pdf: row.pdf,
  };
}

export function EditableVersions({
  paper,
  claimPath,
  children,
}: {
  paper: PaperId;
  claimPath: string;
  children: ReactNode;
}) {
  const [dirty, setDirty] = useState(false);
  const active = useEditing((target) => target === 'versions', dirty);
  if (!active) return children;
  return <VersionsEditor paper={paper} claimPath={claimPath} onDirty={setDirty} />;
}

function VersionsEditor({
  paper,
  claimPath,
  onDirty,
}: {
  paper: PaperId;
  claimPath: string;
  onDirty: (dirty: boolean) => void;
}) {
  const opening = useOpened<VersionsOpened>(paper, 'versions');
  return (
    <EditorFrame label="Editing the versions">
      {opening.status === 'ready' ? (
        <VersionsForm paper={paper} opened={opening.data} onDirty={onDirty} />
      ) : (
        <NotOpened opening={opening} claimPath={claimPath} />
      )}
    </EditorFrame>
  );
}

function VersionsForm({
  paper,
  opened,
  onDirty,
}: {
  paper: PaperId;
  opened: VersionsOpened;
  onDirty: (dirty: boolean) => void;
}) {
  const [initial] = useState(() => JSON.stringify(opened.versions.map((v) => toInput(toRow(v)))));
  const [rows, setRows] = useState<Row[]>(() => opened.versions.map((v) => toRow(v)));
  const [summary, setSummary] = useState('');
  const [evidence, setEvidence] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [lookup, setLookup] = useState<{ busy: boolean; arxiv: string; problems: string[]; done: boolean }>({
    busy: false,
    arxiv: paper.scheme === 'arxiv' ? paper.value : '',
    problems: [],
    done: false,
  });

  const dirty = JSON.stringify(rows.map(toInput)) !== initial || evidence.length > 0;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  function change(at: string, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.key === at ? { ...row, ...patch } : row)));
  }

  async function lookUp() {
    setLookup((l) => ({ ...l, busy: true, problems: [] }));
    try {
      const res = await fetch('/api/v1/pages/versions/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paper, ...(lookup.arxiv.trim() ? { arxiv: lookup.arxiv.trim() } : {}) }),
      });
      if (!res.ok) {
        const message = await messageOf(res);
        return setLookup((l) => ({ ...l, busy: false, problems: [message] }));
      }
      const body = (await res.json()) as { versions: PaperVersion[]; problems: string[] };
      // What is on the page keeps its row and anything typed into it; what was found is added, open to check.
      setRows((current) => {
        const byId = new Map(current.filter((r) => r.id).map((r) => [r.id, r]));
        const typed = current.filter((r) => !r.id);
        const merged = body.versions.map((v) => {
          const was = v.id ? byId.get(v.id) : undefined;
          return was ? { ...toRow(v), key: was.key, note: was.note, open: was.open } : toRow(v, true);
        });
        return [...merged, ...typed];
      });
      setLookup((l) => ({ ...l, busy: false, problems: body.problems, done: true }));
    } catch {
      setLookup((l) => ({ ...l, busy: false, problems: ['Could not reach the server.'] }));
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch('/api/v1/pages/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paper, baseOid: opened.baseOid, versions: rows.map(toInput), summary, evidence }),
      });
      if (!res.ok) {
        const body = await res
          .clone()
          .json()
          .catch(() => null);
        if (body?.error?.code === 'edit_conflict') {
          return setProblem(
            'Someone changed the same version since you opened this. Copy what you changed, reload, and add it again.',
          );
        }
        return setProblem(await messageOf(res));
      }
      onDirty(false);
      reloadAt((await res.json()).head, '#versions');
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

  return (
    <form onSubmit={save}>
      <p className="mb-2 text-xs text-faint">
        Each version the paper has had: preprints, workshop and conference submissions, the camera-ready, a journal
        version. Give each the PDF it had, to compare versions, and evidence that it is what it says.
      </p>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border border-rule bg-white p-2">
        <button type="button" onClick={lookUp} disabled={lookup.busy} className={ui.linkBtn}>
          {lookup.busy ? 'Looking on OpenReview and arXiv…' : 'Look up versions on OpenReview and arXiv'}
        </button>
        <label className="flex items-baseline gap-1 text-muted">
          arXiv id
          <input
            value={lookup.arxiv}
            onChange={(e) => setLookup((l) => ({ ...l, arxiv: e.target.value }))}
            placeholder="found by title"
            className={`${ui.input} mb-0 w-36`}
          />
        </label>
        {lookup.done && lookup.problems.length === 0 && (
          <span className="text-xs text-up">Found versions are added below, open. Check them, then save.</span>
        )}
        {lookup.problems.length > 0 && (
          <ul className="w-full text-xs text-down">
            {lookup.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
      {rows.length === 0 && <p className="text-muted italic">No versions yet.</p>}
      <ol className="space-y-2">
        {rows.map((row, index) => (
          <VersionCard
            key={row.key}
            row={row}
            index={index}
            onChange={(patch) => change(row.key, patch)}
            onRemove={() => setRows((current) => current.filter((r) => r.key !== row.key))}
          />
        ))}
      </ol>
      {rows.length < MAX_VERSIONS && (
        <button
          type="button"
          onClick={() => setRows((current) => [...current, toRow({ label: '', kind: 'conference' }, true)])}
          className={`${ui.linkBtn} mt-2`}
        >
          Add a version
        </button>
      )}
      <div className="mt-4 border-t border-rule pt-3">
        <input
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          maxLength={300}
          placeholder="Summary of the change (optional)"
          aria-label="Summary of the change"
          className={`${ui.input} max-w-96`}
        />
        <EvidenceInput
          value={evidence}
          onChange={setEvidence}
          label="Evidence for this change (optional)"
          hint="Saved with the change in the page's history. Evidence for one version goes on its card."
        />
        <div className="flex flex-wrap items-baseline gap-x-4">
          <span className="flex-1" />
          <button type="submit" disabled={busy} className={ui.btn({ inline: true })}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={cancel} className={ui.btn({ inline: true, ghost: true })}>
            Cancel
          </button>
        </div>
        {problem && <p className={ui.note(false)}>{problem}</p>}
      </div>
    </form>
  );
}

function VersionCard({
  row,
  index,
  onChange,
  onRemove,
}: {
  row: Row;
  index: number;
  onChange: (patch: Partial<Row>) => void;
  onRemove: () => void;
}) {
  const standing = versionStanding({ status: row.status || undefined, decision: row.decision.trim() || undefined });
  const n = index + 1;
  return (
    <li className="border border-rule bg-white">
      <div className="flex flex-wrap items-baseline gap-x-2 px-2 py-1.5">
        <button
          type="button"
          onClick={() => onChange({ open: !row.open })}
          aria-expanded={row.open}
          className="flex-1 cursor-pointer text-left"
        >
          <span className="text-faint">{row.open ? '▾' : '▸'}</span>{' '}
          <span className="font-mono text-xs text-muted">{formatVersionDate(row.date) ?? 'undated'}</span>{' '}
          <b>{row.label || <i className="font-normal text-muted">New version</i>}</b>
          {standing && <span className="text-muted"> · {standing}</span>}
          {row.pdf && <span className={ui.badge}>PDF</span>}
          {!row.id && <span className={ui.badge}>new</span>}
        </button>
        <button type="button" onClick={onRemove} className={ui.linkBtn} aria-label={`Remove version ${n}`}>
          remove
        </button>
      </div>
      {row.open && (
        <div className="grid grid-cols-2 gap-x-3 border-t border-rule px-2 pt-2 narrow:grid-cols-1">
          <label className="col-span-2 block narrow:col-span-1">
            <span className="text-muted">Venue or version</span>
            <input
              value={row.label}
              onChange={(e) => onChange({ label: e.target.value })}
              maxLength={MAX_VERSION_LABEL}
              placeholder="ICLR 2027, NeurIPS 2026 Workshop on …, arXiv v2"
              required
              className={ui.input}
            />
          </label>
          <label className="block">
            <span className="text-muted">Kind</span>
            <select
              value={row.kind}
              onChange={(e) => onChange({ kind: e.target.value as VersionKind })}
              className={ui.input}
            >
              {VERSION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {VERSION_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-muted">Date (submitted or made public)</span>
            <input
              value={row.date}
              onChange={(e) => onChange({ date: e.target.value })}
              placeholder="2026-05-30, or 2026-05"
              pattern="\d{4}(-\d{2}(-\d{2})?)?"
              className={`${ui.input} font-mono`}
            />
          </label>
          <label className="block">
            <span className="text-muted">Status</span>
            <select
              value={row.status}
              onChange={(e) => onChange({ status: e.target.value as VersionStatus | '' })}
              className={ui.input}
            >
              <option value="">—</option>
              {VERSION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {VERSION_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-muted">Decision, as the venue words it</span>
            <input
              value={row.decision}
              onChange={(e) => onChange({ decision: e.target.value })}
              maxLength={MAX_VERSION_DECISION}
              placeholder="Poster, Oral, Spotlight"
              className={ui.input}
            />
          </label>
          <label className="col-span-2 block narrow:col-span-1">
            <span className="text-muted">Address (its forum, arXiv page or proceedings entry)</span>
            <input
              value={row.url}
              onChange={(e) => onChange({ url: e.target.value })}
              type="url"
              placeholder="https://openreview.net/forum?id=…"
              className={ui.input}
            />
          </label>
          <label className="col-span-2 block narrow:col-span-1">
            <span className="text-muted">Title, if it differed (optional)</span>
            <input
              value={row.title}
              onChange={(e) => onChange({ title: e.target.value })}
              maxLength={MAX_VERSION_TITLE}
              className={ui.input}
            />
          </label>
          <div className="col-span-2 narrow:col-span-1">
            <PdfField pdf={row.pdf} onChange={(pdf) => onChange({ pdf })} />
          </div>
          <label className="col-span-2 block narrow:col-span-1">
            <span className="text-muted">What changed from the version before (optional)</span>
            <textarea
              value={row.note}
              onChange={(e) => onChange({ note: e.target.value })}
              maxLength={MAX_VERSION_NOTE}
              rows={2}
              className={ui.input}
            />
          </label>
          <details className="col-span-2 narrow:col-span-1">
            <summary className="cursor-pointer text-muted">Abstract of this version (optional)</summary>
            <textarea
              value={row.abstract}
              onChange={(e) => onChange({ abstract: e.target.value })}
              maxLength={MAX_VERSION_ABSTRACT}
              rows={5}
              className={`${ui.input} mt-1`}
            />
          </details>
          <div className="col-span-2 pb-2 narrow:col-span-1">
            <EvidenceInput
              value={row.evidence}
              onChange={(evidence) => onChange({ evidence })}
              label="Evidence for this version"
              hint="Its acceptance: the venue's list of accepted papers, the decision email, the program."
            />
          </div>
        </div>
      )}
    </li>
  );
}

/** The version's PDF: uploaded, or copied by the server from an archive or proceedings site. */
function PdfField({ pdf, onChange }: { pdf: Row['pdf']; onChange: (pdf: Row['pdf']) => void }) {
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    const stored = await uploadFile(file);
    setBusy(false);
    if (picker.current) picker.current.value = '';
    if (typeof stored === 'string') return setProblem(stored);
    if (stored.type !== 'application/pdf') return setProblem('That is not a PDF.');
    onChange({ url: stored.url });
  }

  async function copy() {
    if (!address.trim()) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch('/api/v1/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: address.trim() }),
      });
      if (!res.ok) return setProblem(await messageOf(res));
      onChange({ url: (await res.json()).url });
      setAddress('');
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-2">
      <span className="text-muted">PDF of this version</span>
      {pdf ? (
        <p className="flex items-baseline gap-3">
          <a href={pdf.url} target="_blank" rel="noopener noreferrer">
            The PDF
          </a>
          {pdf.license && <span className="text-xs text-faint">{pdf.license}</span>}
          <button type="button" onClick={() => onChange(null)} className={ui.linkBtn}>
            remove
          </button>
        </p>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-3">
          <button type="button" onClick={() => picker.current?.click()} disabled={busy} className={ui.linkBtn}>
            {busy ? 'Working…' : 'Upload the PDF'}
          </button>
          <span className="text-faint">or copy it from</span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void copy())}
            type="url"
            placeholder="https://arxiv.org/pdf/2606.18022v1"
            className={`${ui.input} mb-0 max-w-80 flex-1`}
          />
          <button type="button" onClick={copy} disabled={busy} className={ui.linkBtn}>
            Copy
          </button>
          <input
            ref={picker}
            type="file"
            hidden
            accept="application/pdf"
            onChange={(e) => upload(e.target.files?.[0])}
          />
        </div>
      )}
      <p className="text-xs text-faint">
        Public once added. Only add a PDF you may share: an open-access copy, or your own.
      </p>
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </div>
  );
}
