import type { Metadata } from 'next';
import Link from 'next/link';
import { LogoMark, Wordmark } from '@/components/Logo';
import { NavUser } from '@/components/NavUser';
import './globals.css';

export const metadata: Metadata = {
  title: 'PaperTrail',
  description: 'A public, editable page for every research paper, with labeled links between them.',
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
          <Link href="/search" className="font-sans text-[13px]">
            search
          </Link>
          <NavUser />
        </header>
        {children}
      </body>
    </html>
  );
}
