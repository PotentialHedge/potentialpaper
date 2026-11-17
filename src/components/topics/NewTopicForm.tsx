'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ui } from '@/components/ui';
import { parseAliases, topicSlug } from '@/lib/topics';
import { failureOf, send } from './api';
import { useTopicMatches } from './useTopicMatches';

/**
 * The "New topic" form (`handoffs/pages.md` Phase 5): a name, its address, other names, broader topics and the
 * article's first words. As the name is typed it lists topics that are there already, the same name first, so a
 * duplicate isn't made by accident; the server refuses one anyway (`topic_exists`).
 */
export function NewTopicForm({ initialName = '' }: { initialName?: string }) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [aliases, setAliases] = useState('');
  const [broader, setBroader] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; link?: string } | null>(null);
  const matches = useTopicMatches(name);
  const exact = matches.filter((m) => m.exact);
  const shownSlug = slugTouched ? slug : (topicSlug(name) ?? '');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const res = await send('POST', '/topics', {
        name: name.trim(),
        slug: shownSlug,
        aliases: parseAliases(aliases, name),
        broader: broader
          .split(/[\s,]+/)
          .map((s) => s.trim().replace(/^topic:/, ''))
          .filter(Boolean),
        ...(summary.trim() ? { summary: summary.trim() } : {}),
      });
      if (!res.ok) {
        const failure = await failureOf(res);
        const identifier = failure.details?.identifier;
        return setProblem({
          message: failure.message,
          link: typeof identifier === 'string' ? `/t/${identifier.slice('topic:'.length)}` : undefined,
        });
      }
      router.push(`/t/${shownSlug}`);
    } catch {
      setProblem({ message: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <label className="block text-[13px] text-muted">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          placeholder="Linear attention"
          className={`${ui.input} mt-0.5`}
        />
      </label>
      {matches.length > 0 && (
        <div className="text-[13px]" aria-live="polite">
          <p className={exact.length > 0 ? 'text-down' : 'text-muted'}>
            {exact.length > 0 ? 'That topic is there already:' : 'Topics with names like it:'}
          </p>
          <ul className="mt-1 space-y-0.5">
            {matches.map((m) => (
              <li key={m.key}>
                <a href={`/t/${m.key}`}>{m.name}</a>
                {m.matched !== m.name && <span className="text-faint"> (also called {m.matched})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="block text-[13px] text-muted">
        Address: /t/
        <input
          value={shownSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value.toLowerCase());
          }}
          required
          maxLength={60}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          className={`${ui.input} mt-0.5`}
        />
      </label>
      <label className="block text-[13px] text-muted">
        Other names it goes by (optional, separated by commas)
        <input
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          placeholder="Linearized attention, kernelized attention"
          className={`${ui.input} mt-0.5`}
        />
      </label>
      <label className="block text-[13px] text-muted">
        Broader topics (optional, by address, separated by spaces)
        <input
          value={broader}
          onChange={(e) => setBroader(e.target.value)}
          placeholder="efficient-transformers"
          className={`${ui.input} mt-0.5`}
        />
      </label>
      <label className="block text-[13px] text-muted">
        What it is (optional, Markdown): the article&apos;s first section
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={5}
          className={`${ui.input} mt-0.5 font-mono`}
        />
      </label>
      <button className={ui.btn({ inline: true })} disabled={busy || !name.trim() || !shownSlug || exact.length > 0}>
        Make the topic
      </button>
      {problem && (
        <p className={ui.note(false)}>
          {problem.message}
          {problem.link && (
            <>
              {' '}
              <a href={problem.link}>Open it</a>
            </>
          )}
        </p>
      )}
    </form>
  );
}
