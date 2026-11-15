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

Install [Git LFS](https://git-lfs.com) first (`brew install git-lfs`, `apt install git-lfs`; Git for Windows and
GitHub Desktop come with it) and run `git lfs install` once. The page's PDFs and its picture are kept with it, so a
clone then has them as files. Without it the clone still works, and those files are small text "pointers"
instead: everything else can be edited, but a PDF or picture can't be added ([below](#pdfs-and-the-picture)).

A page only has a repository once someone has edited it. Until then the address answers "not found". Make a
first edit on the site to start one.

Or over SSH, with a key on your profile ([below](#over-ssh)):

```sh
git clone ssh://git@git.papers.potentialhedge.com:2222/abs/1706.03762.git
```

## What's in a page

| Path                         | What it is                                            | Who may change it                                                   |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| `community/NN-slug.md`       | the community section, one file per section           | any verified account                                                |
| `author/NN-slug.md`          | the author section                                    | the paper's confirmed authors                                       |
| `versions/<id>.json`         | the paper's versions                                  | any verified account                                                |
| `versions/<id>.pdf`          | that version's PDF (Git LFS)                          | any verified account                                                |
| `links/NN-slug.json`         | the links under the title: `{ "label": …, "url": … }` | its authors once the paper is claimed, else anyone                  |
| `thumbnail.png` (or `.jpg`…) | the picture shown in place of the PDF's first page    | its authors once the paper is claimed, else anyone                  |
| `thumbnail.json`             | the picture's words: `{ "alt": …, "caption": … }`     | as the picture                                                      |
| `demos/<name>/index.html`, … | a demo kept in the page                               | any verified account; once the author section shows it, its authors |
| `.potentialpaper/…`          | metadata and the paper's PDF, written by the site     | nobody but the site                                                 |
| `.gitattributes`             | says which files are Git LFS; the same on every page  | nobody                                                              |
| `prek.toml`                  | checks to run before a commit; the same on every page | nobody                                                              |

Sections can also be `.html` files, from a small allowlist of tags (no scripts, styles or classes). They show
in the order of their file names, so `10-summary.md` comes before `20-results.md`; a section's title is the
`#` heading its file starts with, or else its file name. Every page starts with an empty file for each section
it might have (`community/10-summary.md`, `author/10-tl-dr.md`, …): an empty file isn't shown, so write in one to
add that section, and rename or delete the rest as you like. Files are plain text (UTF-8), at most 256 KB each (1 MB in `demos/`), except
the PDFs and the picture.

### PDFs and the picture

These are kept with Git LFS: the repository holds a pointer (the file's SHA-256 and size), and the bytes are stored
by the site. With Git LFS installed you don't see the pointers; you work with the files:

```sh
cp ~/Downloads/camera-ready.pdf versions/v_k3x9q2ab.pdf     # the PDF of the version in v_k3x9q2ab.json
cp ~/teaser.gif thumbnail.gif                               # the picture; remove any other thumbnail.*
git add versions/v_k3x9q2ab.pdf thumbnail.gif
git commit -m "Add the camera-ready PDF and a teaser"
git push
```

`git push` uploads the files first, with the same API key, then pushes the commit. A version's PDF has to sit beside
its `.json`, and its file can say where it came from and under what license: `"pdf": { "source": "https://…",
"license": "CC BY 4.0" }`. A PDF is at most 40 MB. The picture is a PNG, JPEG, GIF (animated too), WebP or AVIF of at
most 8 MB, named for what it is (`thumbnail.jpg` for a JPEG), and a page has one; its alt text and caption go in
`thumbnail.json`. To go back to the PDF's first page, remove both.

A PDF or picture committed without Git LFS installed is refused with a `remote:` line saying so. Install it, then
`git rm --cached <file>`, `git add <file>`, `git commit --amend` and push again.

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

## Check before you commit

`prek.toml` holds the checks the site runs, to run before each commit with [prek](https://prek.j178.dev)
(`pre-commit` reads it too if you convert it). Once in a clone:

```sh
prek install
```

Then each `git commit` checks the JSON files (syntax, and each against its schema at
`https://papers.potentialhedge.com/schemas/<link|version|thumbnail>.json`), formats the sections with Prettier and
the JSON as the site writes it, and fixes whitespace. A hook that changes a file stops the commit: `git add` the
change and commit again. The site checks every push anyway; the hooks catch mistakes sooner. Editors that read
JSON Schema (VS Code: `json.schemas`) can use the same addresses for completion as you type.

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
- **Files the page takes**, at the paths above, and only where your account may write. A PDF or the picture has to
  be a Git LFS pointer to a file uploaded to the site, which `git push` does when Git LFS is installed.

When the push goes through, the page shows the new text at once, and its history lists your commits with the
same ids as in your clone.

## Over SSH

Instead of an API key, you can push (and clone) with an SSH key, as on GitHub.

1. If you have no key yet, make one: `ssh-keygen -t ed25519`. Ed25519, ECDSA and RSA keys of at least 3072 bits
   work; DSA and shorter RSA keys don't.
2. On your [profile page](https://papers.potentialhedge.com/profile), under SSH keys, paste the public half
   (`~/.ssh/id_ed25519.pub`, one line starting `ssh-ed25519`). A key can be on one account only.
3. Check it: `ssh -T -p 2222 git@git.papers.potentialhedge.com` answers "Hi <your handle>! You've authenticated,
   but PotentialPaper does not provide shell access."

The first time, ssh shows the server's key and asks whether to trust it. Say yes only if the fingerprint is this
one:

```
ED25519 key fingerprint is SHA256:<to be filled in when the server's key is made>
```

The user is always `git`; your key says who you are. A page's SSH address is the page's own path (`abs/…`,
`doi/…`, `openreview/…`), with or without `.git`; the `arxiv/…` form of the HTTPS address works too. To use the
short form `git@git.papers.potentialhedge.com:abs/1706.03762.git`, which has no room for a port, tell ssh the port
once, in `~/.ssh/config`:

```
Host git.papers.potentialhedge.com
  Port 2222
```

To push over SSH from a clone made over HTTPS, change its push address:
`git remote set-url --push origin ssh://git@git.papers.potentialhedge.com:2222/abs/1706.03762.git`. Everything
else is as over HTTPS: the same identity, the same rules, and a confirmed institutional address to push. Removing a
key on your profile stops it working at once.

Git LFS doesn't work over SSH yet. In a clone made over SSH, point it at the HTTPS address once, and it uses your API
key for PDFs and pictures: `git config lfs.url https://papers.potentialhedge.com/git/arxiv/1706.03762.git/info/lfs`.
