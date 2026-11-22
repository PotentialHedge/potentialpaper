'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ui } from '@/components/ui';
import { categorySlug } from '@/lib/categories';
import { failureOf, send } from './api';
import { useCategoryMatches } from './useCategoryMatches';

/**
 * The "New category" form (`handoffs/pages.md` Phase 5): a name, its address and the article's first words. The
 * categories it is in are added afterwards from the Categories box on its page, as any page's are. As the name is typed it lists categories that are there already, the same name first, so a
 * duplicate isn't made by accident; the server refuses one anyway (`category_exists`).
 */
export function NewCategoryForm({ initialName = '' }: { initialName?: string }) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; link?: string } | null>(null);
  const matches = useCategoryMatches(name);
  const exact = matches.filter((m) => m.exact);
  const shownSlug = slugTouched ? slug : (categorySlug(name) ?? '');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const res = await send('POST', '/categories', {
        name: name.trim(),
        slug: shownSlug,
        ...(summary.trim() ? { summary: summary.trim() } : {}),
      });
      if (!res.ok) {
        const failure = await failureOf(res);
        const identifier = failure.details?.identifier;
        return setProblem({
          message: failure.message,
          link: typeof identifier === 'string' ? `/c/${identifier.slice('category:'.length)}` : undefined,
        });
      }
      router.push(`/c/${shownSlug}`);
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
            {exact.length > 0 ? 'That category is there already:' : 'Categories with names like it:'}
          </p>
          <ul className="mt-1 space-y-0.5">
            {matches.map((m) => (
              <li key={m.key}>
                <a href={`/c/${m.key}`}>{m.name}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="block text-[13px] text-muted">
        Address: /c/
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
        What it is (optional, Markdown): the article&apos;s first section
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={5}
          className={`${ui.input} mt-0.5 font-mono`}
        />
      </label>
      <button className={ui.btn({ inline: true })} disabled={busy || !name.trim() || !shownSlug || exact.length > 0}>
        Make the category
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
