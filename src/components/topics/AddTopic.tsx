'use client';

import { type FormEvent, useState } from 'react';
import { ui } from '@/components/ui';
import { TOPIC_LINK_CHOICES, type TopicLinkLabel } from '@/lib/topics';
import { failureOf, send } from './api';
import { useTopicMatches } from './useTopicMatches';

/**
 * "Add a topic" on a paper's page (`handoffs/pages.md` Phase 5): a topic by name, offered from the topics there are
 * as one types; one no topic has is made. Adds a labeled link from the paper (`in-topic` or `introduces-topic`), as
 * the reader's own edit of the paper's links (`POST /api/v1/pages/{identifier}/topics`).
 */
export function AddTopic({ identifier }: { identifier: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [label, setLabel] = useState<TopicLinkLabel>('in-topic');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const matches = useTopicMatches(chosen ? '' : name);
  const exact = matches.find((m) => m.exact);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const topic = chosen ?? exact?.identifier;
      const res = await send('POST', `/pages/${encodeURIComponent(identifier)}/topics`, {
        ...(topic ? { topic } : { name: name.trim() }),
        label,
      });
      if (!res.ok) return setNote({ ok: false, text: (await failureOf(res)).message });
      const body = (await res.json()) as { topic: { name: string; address: string }; created: boolean; status: string };
      setNote({
        ok: true,
        text:
          body.status === 'exists'
            ? `It is in ${body.topic.name} already.`
            : body.created
              ? `Made the topic ${body.topic.name} and added the paper. It shows here within a few minutes.`
              : `Added to ${body.topic.name}. It shows here within a few minutes.`,
        link: body.topic.address,
      });
      setName('');
      setChosen(null);
    } catch {
      setNote({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={`${ui.linkBtn} mt-1.5 text-xs`} onClick={() => setOpen(true)}>
        Add a topic
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="mt-2 text-[13px]">
      <input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setChosen(null);
        }}
        required
        maxLength={120}
        placeholder="A topic, such as Linear attention"
        aria-label="Topic"
        className={ui.input}
      />
      {matches.length > 0 && (
        <ul className="mb-2 space-y-0.5">
          {matches.slice(0, 6).map((m) => (
            <li key={m.key}>
              <button
                type="button"
                className={ui.linkBtn}
                onClick={() => {
                  setChosen(m.identifier);
                  setName(m.name);
                }}
              >
                {m.name}
              </button>
              {m.matched !== m.name && <span className="text-faint"> ({m.matched})</span>}
            </li>
          ))}
        </ul>
      )}
      {name.trim().length > 1 && !chosen && !exact && (
        <p className="mb-2 text-xs text-muted">No topic is called that yet: adding makes it.</p>
      )}
      <fieldset className="mb-2 flex flex-wrap gap-x-3">
        <legend className="sr-only">How the paper is in it</legend>
        {TOPIC_LINK_CHOICES.map((choice) => (
          <label key={choice.label} className="flex items-center gap-1">
            <input type="radio" name="label" checked={label === choice.label} onChange={() => setLabel(choice.label)} />
            The paper {choice.words}
          </label>
        ))}
      </fieldset>
      <button className={ui.btn({ inline: true })} disabled={busy || !name.trim()}>
        Add
      </button>
      {note && (
        <p className={ui.note(note.ok)}>
          {note.text}
          {note.link && (
            <>
              {' '}
              <a href={note.link}>Open the topic</a>
            </>
          )}
        </p>
      )}
    </form>
  );
}
