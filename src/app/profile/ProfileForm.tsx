'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ProfileFields, profileRefusal, type ProfileValues } from '@/components/ProfileFields';
import { ui } from '@/components/ui';

/** Edit what the public sees. */
export function ProfileForm({ initial, institutions }: { initial: ProfileValues; institutions: string[] }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <form
      className="max-w-[420px]"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setNote(null);
        const res = await fetch('/api/v1/me', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            handle: values.handle.trim(),
            realName: values.realName.trim() || null,
            showInstitution: values.showInstitution,
          }),
        }).catch(() => null);
        setBusy(false);
        if (!res?.ok) return setNote({ ok: false, text: await profileRefusal(res) });
        setNote({ ok: true, text: 'Saved.' });
        router.refresh();
      }}
    >
      <ProfileFields values={values} onChange={setValues} institutions={institutions} />
      <button className={ui.btn({ inline: true })} disabled={busy || !values.handle.trim()}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
    </form>
  );
}
