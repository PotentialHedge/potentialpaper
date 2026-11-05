/** The public origin, for absolute links in mail. */
export function siteUrl(): string {
  return (process.env.APP_URL || process.env.BETTER_AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
