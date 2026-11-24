import type { Metadata } from 'next';
import Link from 'next/link';
import { Analytics } from '@/components/Analytics';
import { LogoMark, Wordmark } from '@/components/Logo';
import { NavUser } from '@/components/NavUser';
import { ReportProblem } from '@/components/ReportProblem';
import { TextSettings } from '@/components/TextSettings';
import { siteUrl } from '@/server/site';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  return {
    // Absolute addresses for preview images (`app/opengraph-image.tsx`).
    metadataBase: new URL(siteUrl()),
    title: 'PotentialPaper',
    description: 'A public, editable page for every research paper, with labeled links between them.',
    // Agents find their map of the site from any page.
    alternates: { types: { 'text/markdown': '/llms.txt' } },
    openGraph: { siteName: 'potentialpaper', type: 'website' },
    twitter: { card: 'summary_large_image' },
  };
}

const FOOTER = [
  ['/about', 'About'],
  ['/privacy', 'Privacy'],
  ['/docs', 'API'],
  ['/llms.txt', 'For agents'],
] as const;

/**
 * Reads nothing about the request, on purpose: a page is the same HTML for every reader, so that the
 * edge can cache it, and `NavUser` fills in the viewer afterwards (DESIGN.md §2).
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // `ReviewBlur` marks it before React starts, with the venues the reader isn't a reviewer at.
    <html lang="en" suppressHydrationWarning>
      <body>
        <header className="flex flex-wrap items-baseline gap-x-4.5 gap-y-1.5 px-6 pt-4 pb-2.5 narrow:px-4">
          <Link href="/" aria-label="potentialpaper" className="text-[22px] text-ink hover:no-underline">
            <LogoMark />
            {/* On a phone the mark alone, leaving the row to the account links. */}
            <span className="ml-2 narrow:hidden">
              <Wordmark />
            </span>
          </Link>
          <span className="flex-1" />
          <NavUser />
        </header>
        {children}
        <footer className="flex justify-center gap-x-3 px-6 pb-6 font-sans text-xs text-faint narrow:px-4">
          {FOOTER.map(([href, label]) => (
            <a key={href} href={href} className="text-faint hover:text-ink">
              {label}
            </a>
          ))}
          <ReportProblem className="text-faint hover:text-ink" />
        </footer>
        <Analytics />
        <TextSettings />
      </body>
    </html>
  );
}
