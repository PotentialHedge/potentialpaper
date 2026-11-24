'use client';

import { track } from '@/lib/track';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { CodeInput } from '@/components/CodeInput';
import { InfoTip } from '@/components/InfoTip';
import { ui } from '@/components/ui';
import type { PaperId } from '@/lib/paper-ids';

interface Props {
  paper: PaperId;
  title: string;
  /** As printed on the paper. */
  authors: string[];
  /** Authors someone is already confirmed as. */
  taken: number[];
  pending: { authorIndex: number; evidence: string } | null;
  /** The name the viewer stepped down as, if they did. */
  declined: string | null;
  /** The viewer's confirmed addresses printed on the paper: claiming confirms at once. */
  onPaper: string[];
  /** Under review (`server/under-review.ts`): no names shown, and only an author with an address on it claims. */
  hidden: boolean;
  /** The addresses on the paper's first page, and the author each belongs to where that is clear. */
  printed: { emails: string[]; authorOf: Record<string, number> };
  /** The viewer's confirmed addresses, which co-authors they ask will see. */
  ownAddresses: string[];
  /** The printed names of the paper's confirmed authors, who are asked to confirm a claim. */
  confirmedNames: string[];
  /** Where an invited co-author signs up. */
  inviteUrl: string;
  /** Mail isn't sent but kept for `/dev/mail` (dev without Resend), so the code is read there. */
  devMail: boolean;
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

const list = (names: string[], last = 'and') =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} ${last} ${names[names.length - 1]}`;

/** What a request did, and how to send it again. */
function useRequest() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function run(
    step: string,
    action: () => Promise<Response | null>,
    after: (res: Response) => Promise<void> | void,
  ) {
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      const res = await action();
      if (!res?.ok) {
        track('claim_refused', { target: step, reason: res ? String(res.status) : 'network' });
        return setProblem(await messageOf(res));
      }
      track('claim_step', { target: step });
      await after(res);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return { busy, problem, done, setDone, run };
}

/**
 * Claiming a paper: which printed author you are, then how it is confirmed. With your address on the paper, at once;
 * otherwise by a code to the author's address printed on it (`/claims/code`), or by asking its confirmed co-authors
 * (`/claims/ask`); with none of them here yet, the claim waits and you invite them. Under review, no names are shown,
 * and only the first way is open.
 */
export function ClaimForm(props: Props) {
  if (props.authors.length === 0) {
    return <p className="mt-4">It lists no authors, so it can&apos;t be claimed until they are known.</p>;
  }
  return props.hidden ? <HiddenClaim {...props} /> : <OpenClaim {...props} />;
}

/** Under review: claimed as the author your printed address belongs to, without the names being shown. */
function HiddenClaim({ paper, authors, onPaper, printed }: Props) {
  const { busy, problem, run } = useRequest();
  const index = onPaper.map((e) => printed.authorOf[e]).find((i) => i !== undefined);
  if (onPaper.length === 0) {
    return (
      <p className="mt-4">
        To claim it now, add the address printed on it to <a href="/profile#affiliations">your profile</a>. Otherwise
        you can claim it once its review ends.
      </p>
    );
  }
  if (index === undefined) {
    return (
      <p className="mt-4">
        Your address {onPaper.join(' and ')} is on it, but we can&apos;t tell which author it belongs to. You can claim
        it once its review ends.
      </p>
    );
  }
  return (
    <div className="mt-4">
      <p>Your address {onPaper.join(' and ')} is printed on it.</p>
      <button
        type="button"
        disabled={busy}
        className={`${ui.btn({ inline: true })} mt-2`}
        onClick={() =>
          run(
            'claim',
            () => post('/api/v1/claims', { paper, authorIndex: index, evidence: '' }),
            () => {},
          )
        }
      >
        {busy ? 'Claiming…' : `Claim as ${authors[index]}`}
      </button>
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </div>
  );
}

function OpenClaim(props: Props) {
  const { paper, authors, taken, pending, declined, onPaper, printed, ownAddresses, confirmedNames } = props;
  const { busy, problem, done, setDone, run } = useRequest();
  const [author, setAuthor] = useState<number | null>(
    pending?.authorIndex ?? onPaper.map((e) => printed.authorOf[e]).find((i) => i !== undefined) ?? null,
  );
  const [note, setNote] = useState(pending?.evidence ?? '');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [address, setAddress] = useState<string | null>(null);

  const addressOf = (index: number) => Object.keys(printed.authorOf).find((e) => printed.authorOf[e] === index);
  const unassigned = printed.emails.filter((e) => printed.authorOf[e] === undefined);
  // The chosen author's address on the paper, or every address not clearly someone else's.
  const own = author === null ? undefined : addressOf(author);
  const candidates = own ? [own] : unassigned;
  const chosenAddress =
    address && candidates.includes(address) ? address : candidates.length === 1 ? candidates[0] : null;
  const instant = onPaper.length > 0;
  // Someone else's addresses printed on it: a co-author who joins with one can confirm the claim.
  const confirmers = (who: number | null) =>
    printed.emails.filter((e) => printed.authorOf[e] !== who && !onPaper.includes(e));
  const coAuthorCanJoin = confirmers(author).length > 0;

  const sendCode = () =>
    run(
      'code_sent',
      () => post('/api/v1/claims/code', { paper, authorIndex: author, email: chosenAddress }),
      async (res) => {
        if ((await res.json()).sent) setSentTo(chosenAddress);
      },
    );

  const confirmCode = (value = code) =>
    run(
      'code_confirmed',
      () => post('/api/v1/claims/code/confirm', { paper, email: sentTo, code: value }),
      () => setSentTo(null),
    ).then(() => setCode(''));

  const ask = () =>
    run(
      'ask',
      () => post('/api/v1/claims/ask', { paper, authorIndex: author, evidence: note }),
      async (res) => {
        const body = (await res.json()) as { asked: string[] };
        setDone(
          body.asked.length > 0
            ? `Asked ${list(body.asked)}. You'll get an email when one of them answers.`
            : 'Your claim is waiting.',
        );
      },
    );

  const withdraw = () =>
    run(
      'withdraw',
      () =>
        fetch(`/api/v1/claims?${new URLSearchParams({ scheme: paper.scheme, value: paper.value })}`, {
          method: 'DELETE',
        }).catch(() => null),
      () => setAuthor(null),
    );

  const me = author === null ? '' : authors[author];
  const others = authors
    .map((name, index) => ({ name, index }))
    .filter((a) => a.index !== author && !taken.includes(a.index));
  return (
    <div className="mt-4">
      {declined && <p className="mb-3">You stepped down as {declined}. You can claim it again.</p>}
      {pending && (
        <p className={`${ui.box} mb-4`}>
          Your claim to be <b>{authors[pending.authorIndex]}</b> is waiting
          {confirmedNames.length > 0
            ? ` for ${list(confirmedNames)}`
            : confirmers(pending.authorIndex).length > 0
              ? ` for a co-author with ${list(confirmers(pending.authorIndex), 'or')} to join`
              : ''}
          .{' '}
          <button type="button" className={ui.linkBtn} onClick={withdraw} disabled={busy}>
            Withdraw it
          </button>
        </p>
      )}
      <fieldset>
        <legend className="text-muted">Which author are you?</legend>
        <div className="mt-1 space-y-0.5">
          {authors.map((name, index) => {
            const email = addressOf(index);
            return (
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
                {email && <span className="text-muted"> · {email}</span>}
                {taken.includes(index) && ' (claimed)'}
              </label>
            );
          })}
        </div>
        {unassigned.length > 0 && <p className={ui.fine}>Also on the paper: {unassigned.join(', ')}</p>}
      </fieldset>

      {author !== null && instant && (
        <div className="mt-3">
          <button
            type="button"
            disabled={busy}
            className={ui.btn({ inline: true })}
            onClick={() =>
              run(
                'claim',
                () => post('/api/v1/claims', { paper, authorIndex: author, evidence: '' }),
                () => {},
              )
            }
          >
            {busy ? 'Claiming…' : `Claim as ${me}`}
          </button>
          <span className="ml-2 text-subtle">Your address {onPaper.join(' and ')} is on it.</span>
        </div>
      )}

      {author !== null && !instant && (
        <>
          {candidates.length > 0 && (
            <section className="mt-5">
              <h3 className={ui.boxHeading}>Confirm your email:</h3>
              {sentTo ? (
                <form
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    void confirmCode();
                  }}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span className="w-full text-subtle">
                    We sent a code to {sentTo}. It works for an hour.
                    {props.devMail && (
                      <>
                        {' '}
                        Dev: read it at{' '}
                        <a href="/dev/mail" target="_blank" rel="noreferrer">
                          /dev/mail
                        </a>
                        .
                      </>
                    )}
                  </span>
                  <CodeInput
                    compact
                    value={code}
                    onChange={setCode}
                    onComplete={(value) => confirmCode(value)}
                    disabled={busy}
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={busy || code.length !== 6}
                    className={ui.btn({ inline: true, flush: true })}
                  >
                    {busy ? 'Checking…' : 'Confirm'}
                  </button>
                </form>
              ) : (
                <div>
                  {candidates.length > 1 && (
                    <div className="mb-2 space-y-0.5">
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
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={busy || !chosenAddress}
                    className={ui.btn({ inline: true })}
                    onClick={sendCode}
                  >
                    {busy ? 'Sending…' : chosenAddress ? `Send a code to ${chosenAddress}` : 'Send a code'}
                  </button>
                </div>
              )}
            </section>
          )}

          <section className="mt-5">
            <h3 className={ui.boxHeading}>
              {confirmedNames.length > 0
                ? `${candidates.length > 0 ? 'Or ask' : 'Ask'} your co-authors`
                : coAuthorCanJoin
                  ? `${candidates.length > 0 ? 'Or wait' : 'Wait'} for a co-author`
                  : `${candidates.length > 0 ? 'Or ask' : 'Ask'} us to check`}
              <InfoTip>
                {confirmedNames.length > 0
                  ? `We email ${list(confirmedNames)}; the first to answer decides.`
                  : coAuthorCanJoin
                    ? 'Your claim waits until then.'
                    : 'No co-author can confirm it here yet, so we check your claim by hand.'}{' '}
                {confirmedNames.length > 0 || coAuthorCanJoin
                  ? `They see your address${ownAddresses.length === 1 ? '' : 'es'} (${ownAddresses.join(', ')}) and your note.`
                  : ''}
              </InfoTip>
            </h3>
            {confirmedNames.length === 0 && coAuthorCanJoin && (
              <p className="mb-2">
                {confirmers(author).length === 1 ? 'The author' : 'An author'} with {list(confirmers(author), 'or')} can
                confirm you once they join.
              </p>
            )}
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="A note (optional)"
              aria-label="A note"
              className={ui.input}
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
                    : 'Send the claim'}
            </button>
          </section>

          {confirmedNames.length === 0 && others.length > 0 && <Invite {...props} me={me} others={others} />}
        </>
      )}
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
    `I'm claiming our paper “${title}” on potentialpaper, where authors write a short section about their paper. ` +
    `Could you sign up with your institutional address and confirm that I'm ${me}? It takes a minute:\n\n` +
    `${inviteUrl}\n\nOnce you're in, my request is waiting under My papers.\n\nThanks!`;
  const mailto = (to: string, name: string) =>
    `mailto:${to}?${new URLSearchParams({ subject, body: text(name) }).toString().replace(/\+/g, '%20')}`;
  return (
    <section className="mt-5">
      <h3 className={ui.boxHeading}>Invite a co-author</h3>
      <p>
        Email{' '}
        {others.map(({ name, index }, i) => (
          <span key={index}>
            {i > 0 && ', '}
            <a href={mailto(addressOf(index) ?? '', name)}>{name}</a>
          </span>
        ))}{' '}
        from your own mail, or{' '}
        <button
          type="button"
          className={ui.linkBtn}
          onClick={() => {
            void navigator.clipboard.writeText(text('there')).then(() => setCopied(true));
          }}
        >
          {copied ? 'copied the invitation' : 'copy the invitation'}
        </button>
        .
      </p>
    </section>
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
