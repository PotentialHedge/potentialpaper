'use client';

import { track } from '@/lib/track';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { ProfileFields, profileRefusal, type ProfileValues } from '@/components/ProfileFields';
import { ui } from '@/components/ui';
import { BIO_MAX, PROFILE_LINK_INFO, PROFILE_LINKS, type ProfileLink } from '@/lib/profile';

/**
 * "edit profile" on `/profile`: a modal with what the public sees, the handle, real name and institution, and the bio
 * the person's page shows as its abstract. Saved through `PATCH /api/v1/me`, as every client does.
 */
export function EditProfile({
  initial,
  institutions,
  className,
}: {
  initial: ProfileValues & { bio: string } & Record<ProfileLink, string>;
  institutions: string[];
  className: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <>
      <button
        type="button"
        className={className}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
          track('profile_edit_opened');
        }}
      >
        edit profile
      </button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          setNote(null);
        }}
        title="Edit your profile"
      >
        <form
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
                bio: values.bio.trim() || null,
                ...Object.fromEntries(PROFILE_LINKS.map((link) => [link, values[link].trim() || null])),
                showInstitution: values.showInstitution,
              }),
            }).catch(() => null);
            setBusy(false);
            if (!res?.ok) return setNote({ ok: false, text: await profileRefusal(res) });
            track('profile_saved');
            setNote({ ok: true, text: 'Saved.' });
            router.refresh();
          }}
        >
          <label className="mt-2.5 block font-sans text-[13px] text-muted">
            Bio (optional): a few lines about you and your research, shown on your page as its abstract. Markdown and
            $math$ work.
            <textarea
              value={values.bio}
              onChange={(e) => setValues({ ...values, bio: e.target.value })}
              maxLength={BIO_MAX}
              rows={4}
              data-autofocus
              className={`${ui.input} mt-0.5 resize-y font-serif text-[15px]`}
            />
            <span className="block text-right text-xs text-faint">
              {values.bio.length}/{BIO_MAX}
            </span>
          </label>
          {PROFILE_LINKS.map((link) => (
            <label key={link} className="mt-2.5 block font-sans text-[13px] text-muted">
              {PROFILE_LINK_INFO[link].label} (optional)
              <input
                value={values[link]}
                onChange={(e) => setValues({ ...values, [link]: e.target.value })}
                placeholder={PROFILE_LINK_INFO[link].placeholder}
                autoComplete="off"
                maxLength={300}
                className={`${ui.input} mt-0.5`}
              />
            </label>
          ))}
          <ProfileFields values={values} onChange={(v) => setValues({ ...values, ...v })} institutions={institutions} />
          <button className={ui.btn({ inline: true })} disabled={busy || !values.handle.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {note && <div className={ui.note(note.ok)}>{note.text}</div>}
        </form>
      </Modal>
    </>
  );
}
