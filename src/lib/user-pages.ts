/**
 * What a person's page (`/u/<handle>`, `handoffs/pages.md` Phase 3) may show beyond its handle, its `about/` and its
 * links: each item is a `user.show.<item>` setting in the account's settings.json, and defaults to what DESIGN.md
 * §5.3 allows without asking, so that nothing ties the handle to a real name or an author identity unless the account
 * turns it on. **The institution is the one exception** (`handoffs/pages.md` Phase 4): it is the account's
 * `show_institution`, asked at sign-up and changed on `/profile`, which also puts the institution beside the handle on
 * comments, lists the account among its organisation's members and counts its papers there. One switch, so the
 * institution is never public in one place and hidden in another. The page's `profile.json` repeats the choices (never the values), so a clone of the page says what it
 * shows; the settings are what counts (`server/user-pages.ts`).
 *
 * The items and their defaults are a decision for Benedict to confirm (`handoffs/pages.md`, Open questions).
 *
 * Pure, and shared by the server and the browser.
 */

export const USER_SHOW_ITEMS = ['realName', 'institution', 'claimedPapers', 'activity', 'comments'] as const;
export type UserShowItem = (typeof USER_SHOW_ITEMS)[number];
export type UserShown = Record<UserShowItem, boolean>;

/** The items that are settings: all but the institution, which is the account's `show_institution`. */
export const USER_SHOW_SETTINGS = USER_SHOW_ITEMS.filter(
  (item): item is Exclude<UserShowItem, 'institution'> => item !== 'institution',
);

export interface UserShowInfo {
  /** The settings form's label. */
  title: string;
  description: string;
  /** The §5.3-safe value. */
  default: boolean;
}

export const USER_SHOW: Record<UserShowItem, UserShowInfo> = {
  realName: {
    title: 'Real name',
    description:
      'Show the real name from your profile on your page, under your handle. Off by default: your handle need not say who you are.',
    default: false,
  },
  institution: {
    title: 'Institution',
    description:
      "Show the institutions of your confirmed addresses: on your page, beside your handle on comments, and on your organisation's page, which then lists you as a member and counts the papers you authored. Set on your profile, where you answered it at sign-up; off until you choose.",
    default: false,
  },
  claimedPapers: {
    title: 'Papers you authored',
    description:
      'List the papers you have confirmed authorship of on your page. Off by default: it ties your handle to the name printed on those papers, which nothing else on the site does.',
    default: false,
  },
  activity: {
    title: 'Activity',
    description:
      'List the edits and links you made under your handle, newest first. They are public under your handle on each page already; edits on your own papers, made under your name as an author, are never listed.',
    default: true,
  },
  comments: {
    title: 'Comments',
    description:
      'List the comments you posted under your handle. Anonymous comments, and comments on your own papers (shown under your name as an author), are never listed.',
    default: true,
  },
};

export const userShowKey = (item: UserShowItem) => `user.show.${item}`;

/** The defaults, every item at its §5.3-safe value. */
export const DEFAULT_SHOWN: UserShown = Object.fromEntries(
  USER_SHOW_ITEMS.map((item) => [item, USER_SHOW[item].default]),
) as UserShown;

/**
 * The choices as resolved settings say them, anything not a boolean reading as the default, with the institution as
 * the account's `show_institution` says.
 */
export function shownFromSettings(values: Record<string, unknown>, showInstitution: boolean): UserShown {
  const shown = Object.fromEntries(
    USER_SHOW_SETTINGS.map((item) => {
      const value = values[userShowKey(item)];
      return [item, typeof value === 'boolean' ? value : USER_SHOW[item].default];
    }),
  );
  return Object.fromEntries(
    USER_SHOW_ITEMS.map((item) => [item, item === 'institution' ? showInstitution : shown[item]]),
  ) as UserShown;
}

/** A `profile.json` as the site writes it: the choices, in the items' order, ending with a newline. */
export function profileFileText(shown: UserShown): string {
  return `${JSON.stringify({ show: shown }, null, 2)}\n`;
}
