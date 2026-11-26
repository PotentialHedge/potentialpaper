import type { ReactNode } from 'react';

/** A link as an author's name on a paper is one: the text's own colour, underlined faintly. */
export const ENTITY_LINK = 'text-inherit underline decoration-rule-strong underline-offset-4 hover:decoration-ink';

/**
 * An institution's or venue's name, linked to its page here when it has one (`server/entity-paths.ts`), else plain.
 * No hooks: drawn by server and client components alike.
 */
export function EntityLink({
  name,
  paths,
  className = ENTITY_LINK,
  children,
}: {
  name: string;
  /** Pages by name; a name missing from it has none. */
  paths: Readonly<Record<string, string>> | undefined;
  className?: string;
  /** What to show, when not the name itself. */
  children?: ReactNode;
}) {
  const href = paths?.[name];
  const text = children ?? name;
  return href ? (
    <a href={href} className={className}>
      {text}
    </a>
  ) : (
    <>{text}</>
  );
}

/** Names joined by `separator`, each linked where it has a page. */
export function EntityLinks({
  names,
  paths,
  separator = ', ',
}: {
  names: readonly string[];
  paths: Readonly<Record<string, string>> | undefined;
  separator?: string;
}) {
  return names.map((name, i) => (
    <span key={name}>
      {i > 0 && separator}
      <EntityLink name={name} paths={paths} />
    </span>
  ));
}
