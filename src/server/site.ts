/** The public origin, for absolute links in mail. */
export function siteUrl(): string {
  return (process.env.APP_URL || process.env.BETTER_AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * Where git over SSH is reached, as a clone address starts: `ssh://git@<host>[:<port>]` (`GIT_SSH_URL`). The port
 * is only in the `ssh://` form; with the default port 22 it could be `git@<host>:` (DEPLOY.md, "Git over SSH").
 */
export function gitSshUrl(): string {
  return (process.env.GIT_SSH_URL || 'ssh://git@localhost:2222').replace(/\/+$/, '');
}
