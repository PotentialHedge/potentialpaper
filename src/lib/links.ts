/** Paths shared by Server and Client Components. */

export function setPasswordPath(email: string): string {
  return `/set-password?${new URLSearchParams({ email })}`;
}

/** Sign-up, returning to `next` afterwards. */
export function welcomeHref(next: string): string {
  return next === '/' ? '/welcome' : `/welcome?${new URLSearchParams({ next })}`;
}

/**
 * Where a sign-in or confirmation link from a mail lands (`app/signin/link`): a button, not the
 * sign-in itself. Better Auth's `/magic-link/verify` spends its one-time token on the first GET, and
 * `/verify-email` confirms and signs in whoever opens it first; institutional mail scanners (Safe
 * Links, Proofpoint, …) open every link in a mail before the person does, so a link straight to
 * either was "already used" by the time it was clicked. A password-reset link is safe as it is: its
 * GET only checks the token, and `/set-password` spends it by POST.
 */
export const SIGN_IN_LINK_PATH = '/signin/link';

/** The Better Auth routes a mailed link may open, by the landing page's `?to=`; none means a sign-in link. */
export const MAIL_LINK_TARGETS = {
  'magic-link': {
    action: '/api/auth/magic-link/verify',
    query: ['token', 'callbackURL', 'newUserCallbackURL', 'errorCallbackURL'],
  },
  confirm: { action: '/api/auth/verify-email', query: ['token', 'callbackURL'] },
} as const;

export type MailLinkTarget = keyof typeof MAIL_LINK_TARGETS;

/** The link to mail, from the URL Better Auth built: same origin and query, on our landing page. */
export function mailLinkUrl(authUrl: string): string {
  const url = new URL(authUrl);
  const to = (Object.keys(MAIL_LINK_TARGETS) as MailLinkTarget[]).find(
    (k) => MAIL_LINK_TARGETS[k].action === url.pathname,
  );
  if (!to) throw new Error(`not a mailed auth link: ${url.pathname}`);
  url.searchParams.set('to', to);
  return `${url.origin}${SIGN_IN_LINK_PATH}${url.search}`;
}
