/**
 * Whether an address has a `+tag` in its local part (`ada+x@ethz.ch`). Most
 * mail servers deliver every tag to the same inbox, so with them one person
 * could confirm any number of verified accounts. They are refused
 * wherever an address is checked against the allowlist
 * (`institutionForEmail`), and the forms say why before sending.
 */
export function hasSubaddress(email: string): boolean {
  const at = email.lastIndexOf('@');
  return email.slice(0, at < 0 ? undefined : at).includes('+');
}

/** What a form says to an address with a `+tag`. */
export const SUBADDRESS_REFUSED = 'Use your address without the “+…” part: one inbox, one account.';

/** Shown when sign-up refuses an address: its domain is not on the institution list. */
export const DOMAIN_NOT_LISTED =
  'That address is not from an institution on our list. Use the address your university or lab gave you.';

/** The lower-cased domain of an address, or `null` when it has none. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return domain || null;
}
