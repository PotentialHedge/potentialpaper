/** How long each name takes to scroll past, so the strip's speed doesn't grow with the list. */
const SECONDS_PER_NAME = 4;
/** Fewer names than this read as a list, not a strip: shown not at all. */
const MIN_NAMES = 4;

/** A copy of `items` in random order (Fisher–Yates). */
function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * "Researchers from" and a slow strip of institution names (`institutionNames`) under the home page's title, in a fresh
 * random order on every render. Names, not logos: a logo reads as an endorsement the institution never gave. Pure CSS:
 * the row is drawn twice and slid by half its width, so it loops without a seam. Under reduced motion it stands still,
 * and the second copy is hidden.
 */
export function InstitutionStrip({ names }: { names: string[] }) {
  if (names.length < MIN_NAMES) return null;
  const order = shuffle(names);
  const row = (copy: number) => (
    <ul
      aria-hidden={copy > 0 || undefined}
      className={`flex shrink-0 items-baseline ${copy > 0 ? 'motion-reduce:hidden' : ''}`}
    >
      {order.map((name) => (
        <li key={name} className="shrink-0 whitespace-nowrap after:px-5 after:text-faint after:content-['·']">
          {name}
        </li>
      ))}
    </ul>
  );
  return (
    <section
      aria-label="Where our researchers are from"
      className="mx-auto mt-3 flex max-w-[min(680px,85%)] items-baseline gap-3"
    >
      <span className="shrink-0 font-sans text-[12px] text-muted">Researchers from</span>
      <div className="min-w-0 flex-1 overflow-hidden text-[14px] text-subtle italic [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]">
        <div
          className="flex w-max animate-marquee motion-reduce:animate-none"
          style={{ animationDuration: `${order.length * SECONDS_PER_NAME}s` }}
        >
          {row(0)}
          {row(1)}
        </div>
      </div>
    </section>
  );
}
