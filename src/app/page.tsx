import Link from 'next/link';
import { ui } from '@/components/ui';

/** A placeholder until paper pages exist (IMPLEMENTATION.md, milestone 1). */
export default function Home() {
  return (
    <main className={ui.page}>
      <h1 className="mt-10 text-center text-[28px] leading-tight font-normal">A public page for every paper</h1>
      <p className="mx-auto mt-5 max-w-[620px]">
        <b>Abstract.</b> PaperTrail gives each research paper one page that verified researchers can edit. Its authors
        keep a section of their own, the community keeps another, and labeled links say how papers connect: which ones
        extend, replicate or contradict each other. Every change is kept as a git commit.
      </p>
      <h2 className={ui.groupHeading}>Status</h2>
      <p>
        Paper pages are not here yet. You can already{' '}
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
