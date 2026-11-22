'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ui } from '@/components/ui';
import { failureOf, send } from './api';
import { useTopicMatches } from './useTopicMatches';

/**
 * A topic's editor (`handoffs/pages.md` Phase 5): its name and its article in one commit
 * (`PATCH /api/v1/pages/{identifier}/topic`, merged with whatever changed since the form loaded); renaming it
 * (`/rename`) and merging it into another (`/merge`), each leaving a redirect. The topics it is in are added from the
 * bar at the foot of its page, as any page's are.
 */

interface Initial {
  name: string;
  article: string;
}

export function TopicEditor({
  identifier,
  slug,
  base,
  initial,
}: {
  identifier: string;
  slug: string;
  base: string | null;
  initial: Initial;
}) {
  const router = useRouter();
  const path = `/pages/${encodeURIComponent(identifier)}`;
  const [name, setName] = useState(initial.name);
  const [article, setArticle] = useState(initial.article);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const res = await send('PATCH', `${path}/topic`, {
        base,
        name: name.trim(),
        article,
        summary: summary.trim() || undefined,
      });
      if (!res.ok) return setNote({ ok: false, text: (await failureOf(res)).message });
      const body = (await res.json()) as { changed: boolean };
      if (!body.changed) return setNote({ ok: true, text: 'Nothing changed.' });
      router.push(`/t/${slug}`);
    } catch {
      setNote({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="font-sans text-sm">
      <form onSubmit={save} className="mt-4 space-y-3">
        <label className="block text-[13px] text-muted">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            className={`${ui.input} mt-0.5`}
          />
        </label>
        <label className="block text-[13px] text-muted">
          Article (Markdown, a <code>#</code> heading per section; a heading with nothing under it is left out)
          <textarea
            value={article}
            onChange={(e) => setArticle(e.target.value)}
            rows={22}
            className={`${ui.input} mt-0.5 font-mono`}
          />
        </label>
        <label className="block text-[13px] text-muted">
          What you changed (optional)
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            maxLength={500}
            placeholder="Add the history"
            className={`${ui.input} mt-0.5`}
          />
        </label>
        <button className={ui.btn({ inline: true })} disabled={busy || !name.trim()}>
          Save
        </button>
        {note && <p className={ui.note(note.ok)}>{note.text}</p>}
      </form>
      <Rename path={path} slug={slug} name={initial.name} />
      <Merge path={path} slug={slug} />
    </div>
  );
}

function Rename({ path, slug, name }: { path: string; slug: string; name: string }) {
  const router = useRouter();
  const [newSlug, setNewSlug] = useState(slug);
  const [newName, setNewName] = useState(name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const res = await send('POST', `${path}/rename`, {
        slug: newSlug.trim(),
        ...(newName.trim() !== name ? { name: newName.trim() } : {}),
      });
      if (!res.ok) return setProblem((await failureOf(res)).message);
      router.push(`/t/${newSlug.trim()}`);
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-10 space-y-3">
      <h2 className={ui.sectionHeading}>Rename</h2>
      <p className="text-[13px] text-muted">
        A new address and name. The old address keeps leading here: links that name it still count.
      </p>
      <label className="block text-[13px] text-muted">
        Name
        <input value={newName} onChange={(e) => setNewName(e.target.value)} className={`${ui.input} mt-0.5`} />
      </label>
      <label className="block text-[13px] text-muted">
        Address: /t/
        <input
          value={newSlug}
          onChange={(e) => setNewSlug(e.target.value.toLowerCase())}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxLength={60}
          required
          className={`${ui.input} mt-0.5`}
        />
      </label>
      <button
        className={ui.btn({ ghost: true, inline: true })}
        disabled={busy || (newSlug.trim() === slug && newName.trim() === name)}
      >
        Rename
      </button>
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </form>
  );
}

function Merge({ path, slug }: { path: string; slug: string }) {
  const router = useRouter();
  const [into, setInto] = useState('');
  const [chosen, setChosen] = useState<{ key: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const matches = useTopicMatches(chosen ? '' : into).filter((m) => m.key !== slug);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = chosen?.key ?? into.trim().replace(/^topic:/, '');
    if (!target) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await send('POST', `${path}/merge`, { into: `topic:${target}` });
      if (!res.ok) return setProblem((await failureOf(res)).message);
      const body = (await res.json()) as { address: string };
      router.push(body.address);
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-10 space-y-3">
      <h2 className={ui.sectionHeading}>Merge into another topic</h2>
      <p className="text-[13px] text-muted">
        When this topic is the same idea as another: its sections and links move there, what is in it is in that one,
        and its address leads there. Its history stays.
      </p>
      <input
        value={chosen ? chosen.name : into}
        onChange={(e) => {
          setInto(e.target.value);
          setChosen(null);
        }}
        placeholder="The topic it is the same as"
        aria-label="The topic to merge into"
        className={ui.input}
      />
      {matches.length > 0 && (
        <ul className="space-y-0.5 text-[13px]">
          {matches.slice(0, 6).map((m) => (
            <li key={m.key}>
              <button type="button" className={ui.linkBtn} onClick={() => setChosen({ key: m.key, name: m.name })}>
                {m.name}
              </button>{' '}
              <span className="text-faint">topic:{m.key}</span>
            </li>
          ))}
        </ul>
      )}
      <button className={ui.btn({ ghost: true, inline: true })} disabled={busy || !(chosen || into.trim())}>
        Merge
      </button>
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </form>
  );
}
