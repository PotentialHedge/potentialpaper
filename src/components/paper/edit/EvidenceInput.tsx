'use client';

import { useRef, useState } from 'react';
import { ui } from '@/components/ui';
import { evidenceLabel, evidenceProblem, MAX_EVIDENCE } from '@/lib/evidence';
import { messageOf } from './editing';

/** A file stored by `POST /api/v1/files`. */
export interface StoredFile {
  id: string;
  url: string;
  type: string;
  name: string;
  bytes: number;
  sha256: string;
}

/** Uploads a file to back up an edit, or a version's PDF, and answers with where it is now. */
export async function uploadFile(file: File): Promise<StoredFile | string> {
  const form = new FormData();
  form.set('file', file);
  try {
    const res = await fetch('/api/v1/files', { method: 'POST', body: form });
    if (!res.ok) return res.status === 413 ? 'The file is too large.' : await messageOf(res);
    return (await res.json()) as StoredFile;
  } catch {
    return 'Could not reach the server.';
  }
}

/**
 * Supporting evidence for an edit: links, and files uploaded here (a decision email as a PDF, a screenshot
 * of a proceedings page). Each is saved with the commit, and shows in the page's history beside it.
 */
export function EvidenceInput({
  value,
  onChange,
  label = 'Evidence (optional)',
  hint = 'Links or files that back this up: a venue’s accepted-papers page, a decision email, a proceedings entry.',
}: {
  value: string[];
  onChange: (next: string[]) => void;
  label?: string;
  hint?: string;
}) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const full = value.length >= MAX_EVIDENCE;

  function add(url: string) {
    const clean = url.trim();
    if (!clean) return;
    const bad = evidenceProblem(clean);
    if (bad) return setProblem(`That ${bad}.`);
    setProblem(null);
    if (!value.includes(clean)) onChange([...value, clean]);
    setLink('');
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    const stored = await uploadFile(file);
    setBusy(false);
    if (picker.current) picker.current.value = '';
    if (typeof stored === 'string') return setProblem(stored);
    if (!value.includes(stored.url)) onChange([...value, stored.url]);
  }

  return (
    <fieldset className="mt-2">
      <legend className="text-muted">{label}</legend>
      {value.length > 0 && (
        <ul className="mb-1 space-y-0.5">
          {value.map((url) => (
            <li key={url} className="flex items-baseline gap-2">
              <a href={url} target="_blank" rel="noopener noreferrer" className="truncate" title={url}>
                {evidenceLabel(url)}
              </a>
              <button
                type="button"
                onClick={() => onChange(value.filter((u) => u !== url))}
                className={ui.linkBtn}
                aria-label={`Remove ${evidenceLabel(url)}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <div className="flex flex-wrap items-baseline gap-x-3">
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            // Not a form of its own: Enter here adds the link, it doesn't save the edit.
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add(link))}
            onBlur={() => link.trim() && add(link)}
            type="url"
            placeholder="https://…"
            aria-label="A link to add as evidence"
            className={`${ui.input} max-w-96 flex-1`}
          />
          <button type="button" onClick={() => add(link)} className={ui.linkBtn}>
            Add link
          </button>
          <button type="button" onClick={() => picker.current?.click()} disabled={busy} className={ui.linkBtn}>
            {busy ? 'Uploading…' : 'Upload a file'}
          </button>
          <input
            ref={picker}
            type="file"
            hidden
            accept="application/pdf,image/*,.txt,.md,.csv,.json"
            onChange={(e) => upload(e.target.files?.[0])}
          />
        </div>
      )}
      <p className="text-xs text-faint">{hint} Files are public once uploaded.</p>
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </fieldset>
  );
}
