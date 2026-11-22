'use client';

import { CopyField } from './CopyField';
import { ShareIcon, WITH_ICON } from './icons';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';
import { ui } from './ui';

/** The services' logos (Simple Icons, CC0), drawn in white on their own colour. */
const LOGOS: Record<string, string> = {
  X: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
  Bluesky:
    'M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z',
  LinkedIn:
    'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
};

/** Each service's own share page, prefilled: a plain link, so none of their scripts load and nothing is posted until the reader does it there. */
function services(url: string, title: string) {
  const text = `${title} ${url}`;
  return [
    { name: 'X', color: '#000000', href: `https://x.com/intent/post?${new URLSearchParams({ text: title, url })}` },
    { name: 'Bluesky', color: '#0285FF', href: `https://bsky.app/intent/compose?${new URLSearchParams({ text })}` },
    {
      name: 'LinkedIn',
      color: '#0A66C2',
      href: `https://www.linkedin.com/sharing/share-offsite/?${new URLSearchParams({ url })}`,
    },
    {
      name: 'Email',
      color: '#555555',
      href: `mailto:?${new URLSearchParams({ subject: title, body: url }).toString().replace(/\+/g, '%20')}`,
    },
  ];
}

function Logo({ name }: { name: string }) {
  const d = LOGOS[name];
  if (d) {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="size-3.5" fill="currentColor">
        <path d={d} />
      </svg>
    );
  }
  // Email: an envelope.
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2.5" y="4.5" width="19" height="15" />
      <path d="m3 5 9 7.5L21 5" />
    </svg>
  );
}

/**
 * "share" beside a page's title: its short link to copy, the services to post it on, and for a paper the README
 * badge (`app/badge/[file]`). The short link opens the page, whose preview image is its own (`app/preview/[file]`).
 */
export function SharePopover({
  url,
  title,
  badge,
  className,
}: {
  /** The page's short link, absolute. */
  url: string;
  title: string;
  /** A paper's badge: its image and the Markdown to paste. */
  badge?: { image: string; markdown: string };
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger className={`${className ?? ''} ${WITH_ICON}`}>
        <ShareIcon />
        share
      </PopoverTrigger>
      <PopoverContent>
        <h3 className={ui.boxHeading}>Link</h3>
        <CopyField value={url} label="Short link" />
        <p className="mt-2.5 flex flex-wrap gap-1.5 font-sans text-[13px]">
          {services(url, title).map((s) => (
            <a
              key={s.name}
              href={s.href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ backgroundColor: s.color }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 font-semibold text-white hover:no-underline hover:opacity-85"
            >
              <Logo name={s.name} />
              {s.name}
            </a>
          ))}
        </p>
        {badge && (
          <>
            <h3 className={`${ui.boxHeading} mt-3`}>Badge for a README</h3>
            {/* eslint-disable-next-line @next/next/no-img-element -- an SVG from this site, shown as it will be embedded */}
            <img src={badge.image} alt="" className="mb-1.5 h-5" />
            <CopyField value={badge.markdown} label="Badge Markdown" />
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
