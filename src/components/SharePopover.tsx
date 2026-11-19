'use client';

import { CopyField } from './CopyField';
import { ShareIcon, WITH_ICON } from './icons';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';
import { ui } from './ui';

/** Each service's own share page, prefilled: a plain link, so none of their scripts load and nothing is posted until the reader does it there. */
function services(url: string, title: string) {
  const text = `${title} ${url}`;
  return [
    { name: 'X', href: `https://x.com/intent/post?${new URLSearchParams({ text: title, url })}` },
    { name: 'Bluesky', href: `https://bsky.app/intent/compose?${new URLSearchParams({ text })}` },
    { name: 'LinkedIn', href: `https://www.linkedin.com/sharing/share-offsite/?${new URLSearchParams({ url })}` },
    {
      name: 'Email',
      href: `mailto:?${new URLSearchParams({ subject: title, body: url }).toString().replace(/\+/g, '%20')}`,
    },
  ];
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
        <p className="mt-2 flex flex-wrap gap-x-3 font-sans text-[13px]">
          {services(url, title).map((s) => (
            <a key={s.name} href={s.href} target="_blank" rel="noopener noreferrer" className="text-accent">
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
