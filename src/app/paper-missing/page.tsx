import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** Where `proxy.ts` sends an address with no paper: a 404 that nothing caches. */
export default function PaperMissing() {
  notFound();
}
