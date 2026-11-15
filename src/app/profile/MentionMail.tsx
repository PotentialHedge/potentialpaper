'use client';

import { useState } from 'react';
import { ui } from '@/components/ui';

/** Whether a `@` mention in a comment is mailed (`server/mentions.ts`). Saved as soon as it changes. */
export function MentionMail({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="max-w-[420px] font-sans text-sm">
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
              body: JSON.stringify({ mentionMail: next }),
            }).catch(() => null);
            setBusy(false);
            if (!res?.ok) return setNote({ ok: false, text: 'Could not save that.' });
            setOn(next);
            setNote({ ok: true, text: 'Saved.' });
          }}
        />
        Email me when someone mentions me in a comment
      </label>
      <p className={ui.fine}>By your handle, or by your alias on a paper you commented on anonymously.</p>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
    </div>
  );
}
