'use client';

import { cleanHandleInput, REAL_NAME_MAX } from '@/lib/profile';
import { ui } from './ui';

export interface ProfileValues {
  handle: string;
  realName: string;
  /** `null` until answered: nothing is assumed. */
  showInstitution: boolean | null;
}

const label = 'mt-2.5 block font-sans text-[13px] text-muted';

/** The sentence for a refused `PATCH /me`. */
export async function profileRefusal(res: Response | null): Promise<string> {
  if (!res) return 'Could not reach the server. Try again.';
  const error = (await res.json().catch(() => null))?.error;
  if (error?.code === 'invalid_handle') return error.message;
  if (error?.code === 'handle_taken') return 'That handle is taken.';
  return 'Could not save. Try again.';
}

/**
 * What the public sees (DESIGN.md §5.3): a handle, an optional real name, and an explicit choice about
 * the institution. Verification is between the person and us; showing any of it is up to them.
 */
export function ProfileFields({
  values,
  onChange,
  institutions,
}: {
  values: ProfileValues;
  onChange: (values: ProfileValues) => void;
  institutions?: string[];
}) {
  const where = institutions?.length ? institutions.join(', ') : 'your institution';
  return (
    <>
      <label className={label}>
        Handle (required, can be a pseudonym)
        <input
          value={values.handle}
          onChange={(e) => onChange({ ...values, handle: cleanHandleInput(e.target.value) })}
          autoCapitalize="none"
          autoCorrect="off"
          required
          maxLength={30}
          autoComplete="off"
          spellCheck={false}
          className={`${ui.input} mt-0.5`}
        />
      </label>
      <label className={label}>
        Real name (optional)
        <input
          value={values.realName}
          onChange={(e) => onChange({ ...values, realName: e.target.value })}
          maxLength={REAL_NAME_MAX}
          autoComplete="name"
          className={`${ui.input} mt-0.5`}
        />
      </label>
      <fieldset className="mt-2.5 font-sans text-sm">
        <legend className="text-[13px] text-muted">Show {where} next to your contributions?</legend>
        <label className="mt-1 block cursor-pointer">
          <input
            type="radio"
            name="show-institution"
            checked={values.showInstitution === true}
            onChange={() => onChange({ ...values, showInstitution: true })}
            className="mr-1.5"
          />
          Yes, show it
        </label>
        <label className="mt-1 block cursor-pointer">
          <input
            type="radio"
            name="show-institution"
            checked={values.showInstitution === false}
            onChange={() => onChange({ ...values, showInstitution: false })}
            className="mr-1.5"
          />
          No, just show that I am verified
        </label>
      </fieldset>
      <p className={ui.fine}>
        At a small institution, the name alone can identify you. Moderators can always see your real account. On papers
        you have claimed as an author, you always appear under the name printed on the paper.
      </p>
    </>
  );
}
