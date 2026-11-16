'use client';

import { useState, type ReactNode } from 'react';
import { ui } from '@/components/ui';

/** One email preference on the account, saved as soon as it changes (`PATCH /api/v1/me`). */
function MailToggle({
  field,
  initial,
  label,
  fine,
}: {
  field: 'mentionMail' | 'followMail';
  initial: boolean;
  label: string;
  fine: ReactNode;
}) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="mb-3 max-w-[420px] font-sans text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={async (e) => {
            const next = e.target.checked;
            setBusy(true);
            setNote(null);
            const res = await fetch('/api/v1/me', {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ [field]: next }),
            }).catch(() => null);
            setBusy(false);
            if (!res?.ok) return setNote({ ok: false, text: 'Could not save that.' });
            setOn(next);
            setNote({ ok: true, text: 'Saved.' });
          }}
        />
        {label}
      </label>
      <p className={ui.fine}>{fine}</p>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
    </div>
  );
}

/** What the account is mailed about: `@` mentions (`server/mentions.ts`) and followed papers (`server/follows.ts`). */
export function MailSettings({ mentionMail, followMail }: { mentionMail: boolean; followMail: boolean }) {
  return (
    <>
      <MailToggle
        field="mentionMail"
        initial={mentionMail}
        label="Email me when someone mentions me in a comment"
        fine="By your handle, or by your alias on a paper you commented on anonymously."
      />
      <MailToggle
        field="followMail"
        initial={followMail}
        label="Email me when a paper I follow is edited or commented on"
        fine={
          <>
            Follow a paper with the star under its title; you follow your own papers from the start. See and unfollow
            them on <a href="/papers#following">My papers</a>.
          </>
        }
      />
    </>
  );
}
