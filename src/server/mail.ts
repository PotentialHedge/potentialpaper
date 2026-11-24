import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { Resend } from 'resend';

/**
 * Outbound email, in one place: Resend, because deliverability from a
 * single origin IP is a losing battle.
 *
 * With `RESEND_API_KEY` unset, outside production, mail is not sent: it is
 * kept in an in-process outbox, printed to the server log and shown on `/dev/mail`, so sign-up and
 * institutional verification work in dev and in tests. In production a missing
 * key is an error, never a silent drop.
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** Made with the text by `lib/mail-html.ts` `renderMail`, never without it. */
  html: string;
  /** Extra headers, such as `List-Unsubscribe` (`server/unsubscribe.ts`). */
  headers?: Record<string, string>;
}

// For tests, which read it in the process that sent it; `/dev/mail` reads `DEV_MAIL_FILE`.
const outbox: Mail[] = ((globalThis as { __devOutbox?: Mail[] }).__devOutbox ??= []);

/** Mail "sent" without Resend, newest last. Dev and tests only. */
export function devOutbox(): readonly Mail[] {
  return outbox;
}

/**
 * Dev mail is also appended here, as JSON lines, for `/dev/mail`: route handlers and pages can run in separate
 * workers in dev, which share no memory, and a file also survives a restart.
 */
export const DEV_MAIL_FILE = path.join(process.cwd(), '.next', 'dev-mail.jsonl');

export function clearDevOutbox(): void {
  outbox.length = 0;
}

let client: Resend | undefined;

export async function sendMail(mail: Mail): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('RESEND_API_KEY is not set; refusing to drop mail in production');
    }
    outbox.push(mail);
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
      await appendFile(DEV_MAIL_FILE, JSON.stringify(mail) + '\n').catch(() => {});
      console.info(`[mail:dev] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`);
    }
    return;
  }

  const from = process.env.MAIL_FROM;
  if (!from) throw new Error('MAIL_FROM is not set');
  client ??= new Resend(key);
  // With the HTML part, so no client has to find (and cut) a long link in wrapped text (`lib/mail-html.ts`).
  const { error } = await client.emails.send({
    from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    ...(mail.headers ? { headers: mail.headers } : {}),
  });
  if (error) throw new Error(`resend: ${error.message}`);
}
