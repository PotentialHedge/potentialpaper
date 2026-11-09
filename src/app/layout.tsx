import type { Metadata } from 'next';
import Link from 'next/link';
import { Analytics } from '@/components/Analytics';
import { LogoMark, Wordmark } from '@/components/Logo';
import { NavUser } from '@/components/NavUser';
import './globals.css';

export const metadata: Metadata = {
  title: 'PotentialPaper',
  description: 'A public, editable page for every research paper, with labeled links between them.',
  // Agents find their map of the site from any page.
  alternates: { types: { 'text/markdown': '/llms.txt' } },
};

/**
 * Reads nothing about the request, on purpose: a page is the same HTML for every reader, so that the
 * edge can cache it, and `NavUser` fills in the viewer afterwards (DESIGN.md §2).
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="flex flex-wrap items-baseline gap-x-4.5 gap-y-1.5 px-6 pt-4 pb-2.5 narrow:px-4">
          <Link href="/" className="text-[22px] text-ink hover:no-underline">
            <LogoMark />
            <span className="ml-2">
              <Wordmark />
            </span>
          </Link>
          <span className="flex-1" />
          <NavUser />
        </header>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
