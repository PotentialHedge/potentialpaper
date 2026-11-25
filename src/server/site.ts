/** The public origin, for absolute links in mail. */
export function siteUrl(): string {
  return (process.env.APP_URL || process.env.BETTER_AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * The sites that may frame what the content domain serves (plugins, demos, webviews), as a CSP source list: this
 * site, and the origins `FRAME_ANCESTORS` names, space-separated. Production names staging there, which shows
 * production's content domain in its pages (DEPLOY.md, "Staging").
 */
export function siteFramers(): string {
  const extra = (process.env.FRAME_ANCESTORS ?? '').split(/[\s,]+/).flatMap((value) => {
    const url = value ? URL.parse(value) : null;
    return url && (url.protocol === 'https:' || url.protocol === 'http:') ? [url.origin] : [];
  });
  return [...new Set([new URL(siteUrl()).origin, ...extra])].join(' ');
}

/**
 * Where git over SSH is reached, as a clone address starts: `ssh://git@<host>[:<port>]` (`GIT_SSH_URL`). The port
 * is only in the `ssh://` form; with the default port 22 it could be `git@<host>:` (DEPLOY.md, "Git over SSH").
 */
export function gitSshUrl(): string {
  return (process.env.GIT_SSH_URL || 'ssh://git@localhost:2222').replace(/\/+$/, '');
}
