# PotentialPaper for VS Code

For editing a PotentialPaper page: a paper's page is a git repository of Markdown sections, links, versions and
PDFs. Clone one from the site (each page's **edit** button gives the address) and open the folder.

- **Preview.** A section in `community/` or `author/` opens with a preview beside it, as the page will show it,
  updated as you type (the button in the editor's title, or Cmd+Shift+V). The site renders it, so the first time
  it asks for an API key: make one on your profile, under _API keys and agents_ (read access is enough).
- **PDFs** open as PDFs, with selectable text and working links. In a clone they need Git LFS (`git lfs pull`).
- **JSON files** (`links/*.json`, `versions/*.json`, `thumbnail.json`) are checked as you type against the
  site's schemas, with completion and descriptions on hover.
- **Format Document** formats a section as the page's `prek.toml` does before each commit.
- **PotentialPaper: New Link** adds a link under the title.

The site's address comes from the clone's git remote; set `potentialpaper.origin` to use another.
