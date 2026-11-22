import { AGENT_START_PATH } from '@/lib/agent-prompt';
import { markdown } from '@/server/agent/text';
import { gitSshUrl, siteUrl } from '@/server/site';

export const dynamic = 'force-dynamic';

/**
 * `/agent/setup`: the one setup checklist for an AI agent working for a person here: signing in (by the code in a
 * prompt or one mailed to them, `server/agent-codes.ts`), and, to edit pages' files, git, Git LFS, the page's git
 * identity, credentials for HTTPS and an SSH key on their profile, and the editor extension. Everything else that
 * needs any of it (`/agent/start`, `/agent/add/*`, `/llms.txt`, the Edit dialog's prompt) points here rather than
 * saying it again. Plain Markdown, like `/llms.txt`.
 */
export function GET() {
  const origin = siteUrl();
  const host = new URL(origin).host;
  const api = `${origin}/api/v1`;
  const ssh = process.env.GIT_SSH_URL ? gitSshUrl() : null;
  const sshTarget = ssh ? new URL(ssh.replace(/^ssh:/, 'http:')) : null;
  const sshTest = sshTarget
    ? `ssh -T ${sshTarget.port ? `-p ${sshTarget.port} ` : ''}${sshTarget.username || 'git'}@${sshTarget.hostname}`
    : null;

  const body = `# Set up to work on PotentialPaper

This is the setup checklist for an AI agent working for a person on PotentialPaper (${origin}). Go through it in order and **check each step before you change anything**: much of it may be in place already from an earlier session. Do step 1 always. When the prompt names a page's git path ("Follow this for /git/….git", the clone address \`${origin}/git/….git\`), the person wants to edit that page's files with git: do every step, for that page. Otherwise do steps 2–6 only when they ask you to edit pages with git. When you finish, tell the person in a few lines what was already set up, what you set up, and anything left for them to do.

Ask the person before you install software, and before you change anything outside the page's clone (global git config, \`~/.ssh\`). Never print the token, or a private key, back to them or anywhere else.

## 1. Sign in

You need an API token that acts as the person. Reading needs none; posting and editing do. If the person gives you a key they made on ${origin}/profile, use it. If you already have one for this site from an earlier session (or in git's credential store, step 4), check it with \`GET ${api}/me\` (\`Authorization: Bearer <token>\`) and skip to the end of this step.

**If the prompt gave you a sign-in code** (like \`7K2M-QX9D-4HTB\`), go straight to "Trade the code" below with it: it works once, within an hour. Otherwise sign in one of two ways. Either works whether or not the person has an account: a new address gets one.

**In their browser** (best when they are at a computer, and if you can open one on it): ask for a link, open it for them (\`open <url>\` on macOS, \`xdg-open\` on Linux, \`start\` on Windows) or give it to them, and wait while they sign in there and click Approve.

\`\`\`
POST ${api}/agent/link
Content-Type: application/json

{ "agent": "what you are, e.g. Claude Code" }
\`\`\`

The answer is \`{ "url", "secret", "expiresAt" }\`. Keep \`secret\` to yourself; it is what gets the token. Then poll every 3 seconds or so:

\`\`\`
POST ${api}/agent/link/token
Content-Type: application/json

{ "secret": "<secret>" }
\`\`\`

\`202\` with \`"status": "pending"\` means not yet; \`201\` brings the token, as below. \`410 link_closed\`: they declined, or 15 minutes passed: ask whether to try again. A person who is new signs up on that page with their institutional email, confirms it, and chooses a handle there before approving.

**By a code mailed to them** (when they are not at a browser, or prefer it):

1. Ask the person for their email address at their institution (the one they use on PotentialPaper, if they have an account), and nothing else yet.
2. Ask for a code to be mailed to it:

   \`\`\`
   POST ${api}/agent/code
   Content-Type: application/json

   { "email": "<their address>" }
   \`\`\`

3. Ask for the code in that mail (subject "… is your potentialpaper agent code").
4. **Trade the code** for the token:

   \`\`\`
   POST ${api}/agent/token
   Content-Type: application/json

   { "code": "<the code>" }
   \`\`\`

The code is 12 letters and digits; dashes, spaces and case don't matter. For an address with no account, trading it confirms the address and makes the account. A mailed code works once, within 30 minutes. On \`invalid_code\`, check it with the person, or ask for a new code (2). \`email_domain_not_allowed\` means the address is not at an approved institution.

Either way, the answer's \`token\` (\`pp_live_…\`) is the key. It can read, post, edit and \`git push\` as the person and is shown only this once, so keep it for the whole session, and send it as \`Authorization: Bearer <token>\` on every call that needs it. The person can see and revoke it, named \`ai-agent\`, on ${origin}/profile.

**A new account** (signed up by a mailed code) has no handle yet, and \`GET ${api}/me\` shows \`profileComplete: false\`. Ask the person for one (letters, digits, \`-\`; it is public, in their page's address \`/u/<handle>\`), and whether to show their institution next to it, then \`PATCH ${api}/me\` with \`{ "handle": "<handle>", "showInstitution": true }\` (\`handle_taken\`, \`invalid_handle\`: ask for another). Then offer to claim their papers (${origin}${AGENT_START_PATH}, "Claim their papers"). A password is optional: an emailed link always signs them in on the site.

Then check: \`GET ${api}/me\` answers with their \`handle\`, and \`verified: true\`. Not verified means they have not confirmed an institutional email: they can read, but not post or edit, so tell them.

Send the token only to ${origin} (its API, and its git server as a password). Never log it, print it or send it anywhere else.

## 2. Git and Git LFS

Every page is a git repository; a page's PDFs and picture are kept with Git LFS.

- \`git --version\` and \`git lfs version\` both answer. If not, ask, then install: \`brew install git git-lfs\` (macOS), \`apt install git git-lfs\` (Debian, Ubuntu), Git for Windows (comes with Git LFS).
- \`git lfs install\` has been run once for the user (\`git config --global --get filter.lfs.process\` prints something). If not, run it.

## 3. Clone the page

The prompt usually names the page's git path; its clone address is that path on ${origin}. A page's HTTPS address is its path under \`${origin}/git/\` with \`.git\` at the end (\`${origin}/abs/1706.03762\` → \`${origin}/git/arxiv/1706.03762.git\`; a venue, topic or organisation: \`${origin}/git/<kind>/<key>.git\`)${
    ssh
      ? `; over SSH it is the same path after \`${ssh}/\` (\`${ssh}/abs/1706.03762.git\`, the paper's own address; \`${ssh}/<kind>/<key>.git\` otherwise)`
      : ''
  }.

- Ask where to put it if the person has not said, then \`git clone <address>\` (${ssh ? 'over SSH once step 5 is done, otherwise HTTPS' : 'HTTPS'}). Anyone may clone; no key is needed for that.
- "Not found": the page has no repository yet. It gets one with its first edit, so ask the person to make one in the web editor (the page's address with \`/code\` in front: \`${origin}/code/abs/1706.03762\`), then clone again.
- In the clone, \`git lfs ls-files\` lists the PDFs and picture, and they open as real files, not small text pointers. If they are pointers, step 2 was skipped: do it, then \`git lfs pull\`.

**Set the page's identity, in the clone, not globally.** Pages never carry a name or email address. Each commit is made as an id the site gives the person on that page: \`u_…\` on most pages, \`a_…\` on a paper they are a confirmed author of. You don't look it up: the first push with another identity is refused, and its \`remote:\` lines give the two \`git config user.name\`/\`user.email\` commands for that page. Run them, remake the commits (\`git commit --amend --reset-author --no-edit\`, or \`git rebase --exec 'git commit --amend --reset-author --no-edit' origin/main\` for several) and push again.

Pushes are fast-forward only, no merge commits: \`git pull --rebase\` first when someone else edited the page.

## 4. Credentials for HTTPS

Git asks for a user name (anything; their handle) and a password (the token from step 1). Store it so the person isn't asked:

- See what holds credentials: \`git config --global --get credential.helper\`. Prefer the system's keychain: \`osxkeychain\` (macOS, usually set already), \`manager\` (Git for Windows), \`libsecret\` or, failing that, \`store\` (a plain file, ~/.git-credentials: say so to the person) on Linux. Set one only with their go-ahead.
- Check for a stored one: \`printf 'protocol=https\\nhost=${host}\\n\\n' | git credential fill\` prints a \`password=\` line if there is one (don't show it). Check it with \`GET ${api}/me\`.
- Otherwise store the token:

  \`\`\`sh
  printf 'protocol=https\\nhost=${host}\\nusername=<handle>\\npassword=<token>\\n\\n' | git credential approve
  \`\`\`

- Check: \`git ls-remote <https clone address>\` works without asking for anything.
${
  ssh
    ? `
## 5. An SSH key on their profile

To push over SSH instead, the person's public key has to be on their profile. Only they can add it: adding a key needs their browser session, so a leaked token can never add one.

- Find a key: \`ls ~/.ssh/*.pub\` (\`id_ed25519.pub\` usually). If there is none, ask, then \`ssh-keygen -t ed25519 -C "<handle>@potentialpaper"\` (ask whether they want a passphrase), and make sure \`ssh-agent\` has it (\`ssh-add -l\`).
- Check whether it is on the profile already: \`${sshTest}\` answers "Hi <handle>! You've authenticated…" when it is.
- If not, show the person the **public** key (the \`.pub\` file's one line, never the private file) and ask them to add it under SSH keys on ${origin}/profile#ssh-keys. Wait for them, then check again.
- An existing clone can switch with \`git remote set-url origin <ssh address>\`.
`
    : `
## 5. An SSH key on their profile

This site does not offer git over SSH yet: use HTTPS (step 4).
`
}
## 6. The editor extension (optional)

If the person edits in VS Code, Cursor, Windsurf or VSCodium, ask whether to install the PotentialPaper extension: it previews each section as the page shows it and checks the page's files. \`curl -fsSLo potentialpaper.vsix ${origin}/editor/potentialpaper.vsix && code --install-extension potentialpaper.vsix && rm potentialpaper.vsix\` (\`cursor\`, \`windsurf\` or \`codium\` in place of \`code\`).

In the clone, \`prek install\` (with [prek](https://prek.j178.dev), if they have it or want it) runs the site's checks, in \`prek.toml\`, before each commit.

## Done

Tell the person what is in place, and how to use it: edit the files in the clone (\`community/\` for anyone verified, \`owners/\` for the page's owners), commit, \`git push\`. The site checks each push as it checks an edit on the site and says why on \`remote:\` lines when it refuses one.

## Reference

- [Working on papers for someone](${origin}${AGENT_START_PATH}): what to ask the person, reading papers, posting to their agent discussion, recording versions.
- [llms.txt](${origin}/llms.txt): a map of the site.
- [Updates for agents](${origin}/agent/updates): dated notices of what changed.
`;
  return markdown(body);
}
