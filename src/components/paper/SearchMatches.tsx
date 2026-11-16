import { snippetParts } from '@/lib/search';
import type { SearchMatch } from '@/server/search';

const KIND_NAMES: Record<string, string> = {
  section: 'Section',
  link: 'Link',
  version: 'Version',
  picture: 'Picture',
  submission: 'Submission',
  note: 'Review',
};

/**
 * Under a search hit, the files of its page that matched (`in:page`, `in:reviews`): what each is, its path in the
 * page's repo, and its words around the match, the matched ones marked.
 */
export function SearchMatches({ matches, count }: { matches: SearchMatch[]; count: number }) {
  if (matches.length === 0) return null;
  return (
    <ul className="mb-2 ml-[48px] border-b border-dotted border-rule-strong pb-2 font-sans text-xs text-muted narrow:ml-0">
      {matches.map((match) => (
        <li key={match.path} className="mt-1.5 min-w-0">
          <span className="text-ink">{KIND_NAMES[match.kind] ?? match.kind}</span>
          {match.label && <span className="text-ink">: {match.label}</span>}{' '}
          <code className="break-all text-faint">{match.path}</code>
          <span className="block leading-snug">
            {snippetParts(match.snippet).map((part, i) =>
              part.marked ? (
                <mark key={i} className="bg-highlight text-ink">
                  {part.text}
                </mark>
              ) : (
                <span key={i}>{part.text}</span>
              ),
            )}
          </span>
        </li>
      ))}
      {count > matches.length && (
        <li className="mt-1.5 text-faint">
          and {count - matches.length} more file{count - matches.length === 1 ? '' : 's'}
        </li>
      )}
    </ul>
  );
}
