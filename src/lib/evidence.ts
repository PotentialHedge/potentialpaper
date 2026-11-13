/**
 * Supporting evidence for an edit: links, or files uploaded to `POST /api/v1/files`, that back up what was
 * changed (a venue's acceptance page, a camera-ready PDF, an email from the program chairs). A commit carries
 * them as `Evidence:` trailers (`server/pages/git-objects.ts`), so they are part of the page's git history.
 * Pure, so the server, the editors and the tests share it.
 */

export const MAX_EVIDENCE = 10;
export const MAX_EVIDENCE_URL = 2000;

/**
 * An evidence address's problem, or `null`. `https:` only, or a path on this site (an upload, in
 * development). It goes into a commit trailer, so it can't hold whitespace.
 */
export function evidenceProblem(url: string): string | null {
  if (url.length === 0 || url.length > MAX_EVIDENCE_URL)
    return `needs an address of at most ${MAX_EVIDENCE_URL} characters`;
  if (/[\s\p{C}]/u.test(url)) return 'has a space or a control character';
  if (/^\/[^/\\]/.test(url)) return null;
  const parsed = URL.parse(url);
  if (!parsed || parsed.protocol !== 'https:') return 'needs an https address';
  return null;
}

/** The evidence, trimmed, de-duplicated and checked, or a problem naming the first bad one. */
export function cleanEvidence(urls: readonly string[]): { evidence: string[] } | { problem: string } {
  const evidence = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
  if (evidence.length > MAX_EVIDENCE) return { problem: `at most ${MAX_EVIDENCE} pieces of evidence` };
  for (const [index, url] of evidence.entries()) {
    const problem = evidenceProblem(url);
    if (problem) return { problem: `evidence ${index + 1} ${problem}` };
  }
  return { evidence };
}

/** What to call a piece of evidence in a list: the file's name for an upload here, else the site. */
export function evidenceLabel(url: string): string {
  const parsed = URL.parse(url, 'https://local.invalid');
  if (!parsed) return url;
  let file = parsed.pathname.split('/').pop() ?? '';
  try {
    file = decodeURIComponent(file);
  } catch {}
  // Ours are named by their hash (`server/files.ts`).
  if (/^[0-9a-f]{64}(\.pdf$|-)/.test(file)) {
    if (/^[0-9a-f]{64}\.pdf$/.test(file)) return 'uploaded PDF';
    return file.replace(/^[0-9a-f]{64}-/, '') || 'uploaded file';
  }
  if (parsed.hostname === 'local.invalid') return file || url;
  return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.length > 1 ? '/…' : ''}`;
}
