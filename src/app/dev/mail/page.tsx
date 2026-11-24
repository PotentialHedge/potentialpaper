import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ui } from '@/components/ui';
import { readFile } from 'node:fs/promises';
import { DEV_MAIL_FILE, type Mail } from '@/server/mail';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dev mail · potentialpaper', robots: { index: false, follow: false } };

/**
 * The mail the site would have sent, newest first: in dev without `RESEND_API_KEY` nothing is sent (`server/mail.ts`).
 * Not there in production. Read from `.next/dev-mail.jsonl`, so it survives a restart until `.next` is cleared.
 */
export default async function DevMail() {
  if (process.env.NODE_ENV === 'production' || process.env.RESEND_API_KEY) notFound();
  const lines = await readFile(DEV_MAIL_FILE, 'utf8').catch(() => '');
  const mails = lines
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Mail)
    .reverse();
  return (
    <main className={ui.page}>
      <h1 className="mt-6 text-[26px] font-normal">Dev mail</h1>
      <p className="mt-2 font-sans text-sm text-subtle">
        Nothing is sent here: this is what would have gone out, newest first. Reload for new ones.
      </p>
      {mails.length === 0 ? (
        <p className={ui.empty}>No mail yet.</p>
      ) : (
        <ul className="mt-4 space-y-4 font-sans text-sm">
          {mails.map((mail, i) => (
            <li key={mails.length - i} className={ui.box}>
              <div className="text-muted">To {mail.to}</div>
              <div className="font-semibold">{mail.subject}</div>
              <pre className="mt-2 font-sans whitespace-pre-wrap">{mail.text}</pre>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
