'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ui } from '@/components/ui';
import type { PaperId } from '@/lib/paper-ids';

interface Props {
  paper: PaperId;
  pagePath: string;
  title: string;
  /** As printed on the paper. */
  authors: string[];
  /** Authors someone is already confirmed as. */
  taken: number[];
  pending: { authorIndex: number; evidence: string } | null;
  /** One of the viewer's addresses is on the paper, so the claim will be confirmed when sent. */
  instant: boolean;
  /** The addresses on the paper's first page, and the author each belongs to where that is clear. */
  printed: { emails: string[]; authorOf: Record<string, number> };
  /** The viewer's confirmed addresses, which co-authors they ask will see. */
  ownAddresses: string[];
  /** The printed names of the paper's confirmed authors, who are asked to confirm a claim. */
  confirmedNames: string[];
  /** Where an invited co-author signs up. */
  inviteUrl: string;
}

async function messageOf(res: Response | null): Promise<string> {
  if (!res) return 'Could not reach the server.';
  if (res.status === 401) return 'Your session ended. Sign in again in another tab.';
  if (res.status === 429) return 'Too many requests. Try again later.';
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? `Something went wrong (${res.status}).`;
}

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);

const list = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * Claiming a paper: which printed author you are, then how it is confirmed. With your address on the paper, at once;
 * otherwise by a code to the author's address printed on it (`/claims/code`), or by asking its confirmed co-authors
 * (`/claims/ask`); with none of them here yet, the claim waits and you invite them.
 */
export function ClaimForm(props: Props) {
  const { paper, authors, taken, pending, instant, printed, ownAddresses, confirmedNames } = props;
  const router = useRouter();
  const [author, setAuthor] = useState<number | null>(pending?.authorIndex ?? null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [note, setNote] = useState(pending?.evidence ?? '');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');

  // The chosen author's address on the paper, or every address not clearly someone else's.
  const own = author === null ? undefined : Object.keys(printed.authorOf).find((e) => printed.authorOf[e] === author);
  const candidates = own ? [own] : printed.emails.filter((e) => printed.authorOf[e] === undefined);
  const [address, setAddress] = useState<string | null>(null);
  const chosenAddress =
    address && candidates.includes(address) ? address : candidates.length === 1 ? candidates[0] : null;

  async function run(action: () => Promise<Response | null>, after: (res: Response) => Promise<void> | void) {
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      const res = await action();
      if (!res?.ok) return setProblem(await messageOf(res));
      await after(res);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const claimNow = () =>
    run(
      () => post('/api/v1/claims', { paper, authorIndex: author, evidence: '' }),
      () => {},
    );

  const sendCode = () =>
    run(
      () => post('/api/v1/claims/code', { paper, authorIndex: author, email: chosenAddress }),
      async (res) => {
        const body = await res.json();
        if (body.sent) setSentTo(chosenAddress);
      },
    );

  const confirmCode = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () => post('/api/v1/claims/code/confirm', { paper, email: sentTo, code }),
      () => setSentTo(null),
    );
  };

  const ask = () =>
    run(
      () => post('/api/v1/claims/ask', { paper, authorIndex: author, evidence: note }),
      async (res) => {
        const body = (await res.json()) as { asked: string[] };
        setDone(
          body.asked.length > 0
            ? `Asked ${list(body.asked)}. You'll get an email when one of them answers.`
            : 'Your claim is waiting. Invite a co-author below.',
        );
      },
    );

  async function withdraw() {
    await run(
      () =>
        fetch(`/api/v1/claims?${new URLSearchParams({ scheme: paper.scheme, value: paper.value })}`, {
          method: 'DELETE',
        }).catch(() => null),
      () => setAuthor(null),
    );
  }

  if (authors.length === 0) return <p className="mt-4">This paper lists no authors, so it can&apos;t be claimed.</p>;
  const me = author === null ? '' : authors[author];
  const others = authors
    .map((name, index) => ({ name, index }))
    .filter((a) => a.index !== author && !taken.includes(a.index));
  return (
    <div className="mt-4">
      {pending && (
        <p className={`${ui.box} mb-4`}>
          Your claim to be <b>{authors[pending.authorIndex]}</b> is waiting.{' '}
          {confirmedNames.length > 0
            ? `${list(confirmedNames)} can confirm it on their My papers page.`
            : 'It is decided when a co-author joins and confirms it.'}{' '}
          You can also confirm it with a code below, or{' '}
          <button type="button" className={ui.linkBtn} onClick={withdraw} disabled={busy}>
            withdraw it
          </button>
          .
        </p>
      )}
      <fieldset>
        <legend className="text-muted">Which author are you?</legend>
        <div className="mt-1 space-y-0.5">
          {authors.map((name, index) => (
            <label key={index} className={`block ${taken.includes(index) ? 'text-faint' : ''}`}>
              <input
                type="radio"
                name="author"
                checked={author === index}
                onChange={() => setAuthor(index)}
                disabled={taken.includes(index)}
                className="mr-2"
              />
              {name}
              {taken.includes(index) && ' (confirmed)'}
            </label>
          ))}
        </div>
      </fieldset>

      {author !== null && instant && (
        <div className="mt-3">
          <button type="button" disabled={busy} className={ui.btn({ inline: true })} onClick={claimNow}>
            {busy ? 'Claiming…' : `Claim as ${me}`}
          </button>
        </div>
      )}

      {author !== null && !instant && (
        <>
          <h3 className={`${ui.boxHeading} mt-5`}>With your address on the paper</h3>
          {candidates.length === 0 ? (
            <p className="text-muted">
              {printed.emails.length === 0
                ? 'We could not read any addresses on this paper.'
                : `The paper doesn't print an address for ${me}.`}
            </p>
          ) : sentTo ? (
            <form onSubmit={confirmCode} className="flex flex-wrap items-start gap-2">
              <span className="w-full text-subtle">We sent a code to {sentTo}. It works for an hour.</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                aria-label="Code"
                className={`${ui.input} max-w-[10rem]`}
                autoFocus
              />
              <button type="submit" disabled={busy || !code.trim()} className={ui.btn({ inline: true, flush: true })}>
                {busy ? 'Checking…' : 'Confirm'}
              </button>
            </form>
          ) : (
            <div>
              {own ? (
                <p className="text-subtle">
                  The paper prints <b className="font-semibold">{own}</b> for {me}.
                </p>
              ) : (
                <fieldset>
                  <legend className="text-subtle">Which of the addresses on the paper is yours?</legend>
                  {candidates.map((e) => (
                    <label key={e} className="block">
                      <input
                        type="radio"
                        name="address"
                        checked={chosenAddress === e}
                        onChange={() => setAddress(e)}
                        className="mr-2"
                      />
                      {e}
                    </label>
                  ))}
                </fieldset>
              )}
              <button
                type="button"
                disabled={busy || !chosenAddress}
                className={`${ui.btn({ inline: true })} mt-2`}
                onClick={sendCode}
              >
                {busy ? 'Sending…' : 'Send me a code'}
              </button>
            </div>
          )}

          <h3 className={`${ui.boxHeading} mt-5`}>
            {confirmedNames.length > 0 ? 'Or ask your co-authors' : 'Or wait for a co-author'}
          </h3>
          <p className="text-subtle">
            {confirmedNames.length > 0
              ? `${list(confirmedNames)} ${confirmedNames.length === 1 ? 'is' : 'are'} on PotentialPaper. We email them, and the first to answer decides.`
              : 'None of your co-authors is on PotentialPaper yet. Your claim waits, and the first to join is asked to confirm it.'}{' '}
            They see your address{ownAddresses.length === 1 ? '' : 'es'} {ownAddresses.join(', ')} and your note.
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="A note for them (optional)"
            aria-label="A note for your co-authors"
            className={`${ui.input} mt-2`}
          />
          <button type="button" disabled={busy} className={ui.btn({ inline: true })} onClick={ask}>
            {busy
              ? 'Sending…'
              : confirmedNames.length > 0
                ? pending
                  ? 'Ask them again'
                  : 'Ask them'
                : pending
                  ? 'Update the claim'
                  : 'Claim and wait'}
          </button>

          {confirmedNames.length === 0 && others.length > 0 && <Invite {...props} me={me} others={others} />}
        </>
      )}
      <p className={ui.fine}>
        If the paper is still under double-blind review, claiming it reveals that you wrote it once your claim is
        confirmed.
      </p>
      {done && <p className={ui.note(true)}>{done}</p>}
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </div>
  );
}

/** Inviting co-authors who aren't here yet: a mail of your own, from a template, or the text to paste anywhere. */
function Invite({
  title,
  inviteUrl,
  printed,
  me,
  others,
}: Props & { me: string; others: { name: string; index: number }[] }) {
  const [copied, setCopied] = useState(false);
  const addressOf = (index: number) => Object.keys(printed.authorOf).find((e) => printed.authorOf[e] === index);
  const subject = `Can you confirm me on “${title}”?`;
  const text = (name: string) =>
    `Hi ${name.split(' ')[0]},\n\n` +
    `I'm claiming our paper “${title}” on PotentialPaper, where authors write a short section about their paper. ` +
    `Could you sign up with your institutional address and confirm that I'm ${me}? It takes a minute:\n\n` +
    `${inviteUrl}\n\nOnce you're in, my request is waiting under My papers.\n\nThanks!`;
  const mailto = (to: string, name: string) =>
    `mailto:${to}?${new URLSearchParams({ subject, body: text(name) }).toString().replace(/\+/g, '%20')}`;
  return (
    <div className="mt-4">
      <h3 className={ui.boxHeading}>Invite a co-author</h3>
      <ul className="space-y-0.5">
        {others.map(({ name, index }) => {
          const to = addressOf(index);
          return (
            <li key={index}>
              {name}
              {to && <span className="text-muted"> · {to}</span>} · <a href={mailto(to ?? '', name)}>email them</a>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className={`${ui.linkBtn} mt-1`}
        onClick={() => {
          void navigator.clipboard.writeText(text('there')).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied the invitation' : 'Copy the invitation'}
      </button>
    </div>
  );
}

/** For an author the site made automatically: takes it back, so they aren't made the author again. */
export function StepDown({ paper }: { paper: PaperId }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function stepDown() {
    setBusy(true);
    setProblem(null);
    try {
      const query = new URLSearchParams({ scheme: paper.scheme, value: paper.value });
      const res = await fetch(`/api/v1/claims?${query}`, { method: 'DELETE' });
      if (!res.ok) return setProblem(await messageOf(res));
      router.refresh();
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className={ui.linkBtn} onClick={stepDown} disabled={busy}>
        {busy ? 'Stepping down…' : 'Not you, or rather not be listed? Step down as its author'}
      </button>
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </>
  );
}
