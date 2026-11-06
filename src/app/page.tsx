import Link from 'next/link';
import { SearchForm } from '@/components/paper/SearchForm';
import { ui } from '@/components/ui';

export default function Home() {
  return (
    <main className={ui.page}>
      <h1 className="mt-10 text-center text-[28px] leading-tight font-normal">A public page for every paper</h1>
      <p className="mx-auto mt-5 max-w-[620px]">
        <b>Abstract.</b> PotentialPaper gives each research paper one page that verified researchers can edit. Its
        authors keep a section of their own, the community keeps another, and labeled links say how papers connect:
        which ones extend, replicate or contradict each other. Every change is kept as a git commit.
      </p>
      <h2 className={ui.groupHeading}>Find a paper</h2>
      <SearchForm />
      <p className={ui.fine}>
        Search by title, or paste an arXiv id or DOI. Any arXiv link works here too: change the domain of{' '}
        <span className={ui.mono}>arxiv.org/abs/1706.03762</span> to this site&apos;s.
      </p>
      <h2 className={ui.groupHeading}>Status</h2>
      <p>
        Paper pages can be read, but not yet edited. You can already{' '}
        <Link href="/welcome" className="text-accent">
          join with your institutional email
        </Link>{' '}
        or{' '}
        <Link href="/institutions/request" className="text-accent">
          request your institution
        </Link>
        .
      </p>
    </main>
  );
}
