/** What the extension reads from paths and addresses, apart from VS Code so it can be tested on its own. */

/** A section file, which the page shows as prose: `community/10-summary.md`, `owners/20-results.html`. */
const SECTION = /^(?:owners|community)\/\d{2}-[a-z0-9-]+\.(md|html)$/;

export type SectionFormat = 'markdown' | 'html';

export function sectionFormat(path: string | null): SectionFormat | null {
  const match = path ? SECTION.exec(path) : null;
  return match ? (match[1] === 'md' ? 'markdown' : 'html') : null;
}

/** `https://papers.example.com/git/abs/1706.03762.git` → `https://papers.example.com`; SSH remotes by their web host. */
export function originOfRemote(url: string): string | null {
  const https = /^(https?:\/\/[^/\s]+)\/git\//.exec(url);
  if (https) return https[1].replace(/\/\/[^@/]*@/, '//');
  // ssh://git@git.papers.example.com:2222/abs/1706.03762.git, or git@git.papers.example.com:abs/….git
  const ssh = /^(?:ssh:\/\/)?[^@\s]+@([^:/\s]+)/.exec(url);
  if (ssh && /[/:](?:abs|arxiv|openreview|doi)\//.test(url)) {
    return `https://${ssh[1].replace(/^git\./, '')}`;
  }
  return null;
}
