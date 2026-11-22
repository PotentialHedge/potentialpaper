import type { Metadata } from 'next';
import Link from 'next/link';
import { ui } from '@/components/ui';

export const metadata: Metadata = {
  title: 'About · PotentialPaper',
  description: 'A public, editable page for every research paper, with labeled links between them.',
  alternates: { canonical: '/about' },
};

const prose = 'mt-2 space-y-3 leading-relaxed';

/** What the site is, in a few paragraphs. It must stay true to the code, as `/privacy` must. */
export default function AboutPage() {
  return (
    <main className={`${ui.page} max-w-[640px]`}>
      <h1 className="mt-6 text-center text-[26px] leading-tight font-normal">About PotentialPaper</h1>

      <h2 className={ui.groupHeading}>What it is</h2>
      <div className={prose}>
        <p>
          Every research paper gets one public page, at its arXiv id, DOI or OpenReview id. A page has an author
          section, written only by the paper&apos;s confirmed authors, and a community section that any verified
          researcher may edit: summaries, critique, errata, reproductions. The venue&apos;s reviews and decisions sit
          beside them.
        </p>
        <p>
          Papers are joined by labeled links, such as &ldquo;extends&rdquo; or &ldquo;fails to replicate&rdquo;, each a
          public claim with an author and a history. Venues, categories, organisations and people have pages too.
        </p>
      </div>

      <h2 className={ui.groupHeading}>Who writes</h2>
      <div className={prose}>
        <p>
          Reading needs no account. Writing needs an institutional email address. Who said what is always shown: an
          author&apos;s words, the community&apos;s and a bot&apos;s never look alike.
        </p>
      </div>

      <h2 className={ui.groupHeading}>Open by design</h2>
      <div className={prose}>
        <p>
          Every page is a git repository: each change is a commit, and any page can be cloned. The site is one client of
          its own API, which bots, AI agents and plugins use too. See <Link href="/docs">the API</Link>,{' '}
          <Link href="/llms.txt">the guide for agents</Link> and <Link href="/plugins.md">building a plugin</Link>.
        </p>
        <p>
          What is stored about you is on the <Link href="/privacy">privacy page</Link>.
        </p>
      </div>
    </main>
  );
}
