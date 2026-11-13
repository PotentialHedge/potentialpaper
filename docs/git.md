# Editing a paper's page with git

Every paper's page is a git repository. You can clone it, edit its files in your own editor and push the
changes back. The page then shows them, as if you had made the edit on the site.

## Clone

Anyone can clone a page, with no account and no key. The address is the paper's own, under `/git/` and with
`.git` at the end:

```sh
git clone https://papers.potentialhedge.com/git/arxiv/1706.03762.git
git clone https://papers.potentialhedge.com/git/doi/10.1000/xyz123.git
git clone https://papers.potentialhedge.com/git/openreview/dskf2Ppd9o.git
```

A page only has a repository once someone has edited it. Until then the address answers "not found". Make a
first edit on the site to start one.

## What's in a page

| Path                         | What it is                                            | Who may change it                                                   |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| `community/NN-slug.md`       | the community section, one file per section           | any verified account                                                |
| `author/NN-slug.md`          | the author section                                    | the paper's confirmed authors                                       |
| `versions/<id>.json`         | the paper's versions                                  | any verified account                                                |
| `links/NN-slug.json`         | the links under the title: `{ "label": …, "url": … }` | its authors once the paper is claimed, else anyone                  |
| `demos/<name>/index.html`, … | a demo kept in the page                               | any verified account; once the author section shows it, its authors |
| `.potentialpaper/…`          | metadata and the PDF, written by the site             | nobody but the site                                                 |

Sections can also be `.html` files, from a small allowlist of tags (no scripts, styles or classes). They show
in the order of their file names, so `10-summary.md` comes before `20-results.md`; a section's title is the
`#` heading its file starts with. Files are plain text (UTF-8), at most 256 KB each (1 MB in `demos/`).

## Make an API key that may push

On your [profile page](https://papers.potentialhedge.com/profile), under API keys, make a key with **Allow
`git push` to papers' pages** ticked. Untick "Allow posting…" if the key is only for git: that key can then
push and nothing else. The key is shown once; copy it.

Your account needs a confirmed institutional address to push, as for every edit.

## Set your identity on the page

Pages never carry your name or email address. Each commit is made as an id the site gives you on that page:

- `u_…` on most pages, the same on all of them;
- `a_…` on a paper you are a confirmed author of, a different one per paper, so that what you write there as
  its author can't be tied to your other edits.

Set it in the clone, not globally:

```sh
cd 1706.03762
git config user.name u_7k3x9q2a
git config user.email u_7k3x9q2a@users.invalid
```

You don't need to look your id up: push once, and if the identity is wrong the push is refused with these two
commands, filled in for that page. Then remake your commits with the new identity:

```sh
git commit --amend --reset-author --no-edit                                     # one commit
git rebase --exec 'git commit --amend --reset-author --no-edit' origin/main     # several
```

## Push

```sh
git add community/20-related-work.md
git commit -m "Add related work"
git push
```

Git asks for a user name and a password. The user name can be anything (your handle, say); the password is the
API key. To have git remember it, turn on a credential helper (`git config --global credential.helper store`,
or your system's keychain) before pushing.

### What a push has to be

The site checks each pushed commit as it checks an edit made on the site, and refuses the whole push if one
fails. Git prints why, on lines starting with `remote:`.

- **On top of the page as it is now.** If someone edited the page since you cloned it, git says "fetch first":
  `git pull --rebase`, then push again.
- **One line of commits, no merges.** Rebase instead of merging (`git pull --rebase`).
- **Only `main`.** Other branches, tags and deleting `main` are refused.
- **Your identity on that page**, as author and as committer (above). Signed commits are refused, since a
  signature names its key: `git config commit.gpgsign false`.
- **A one-line summary** first in the message, at most 50 commits a push. Evidence goes in trailers at the end
  of the message, one per line: `Evidence: https://…`. Lines like `Signed-off-by: Name <address>` are refused.
- **Files the page takes**, at the paths above, and only where your account may write.

When the push goes through, the page shows the new text at once, and its history lists your commits with the
same ids as in your clone.
