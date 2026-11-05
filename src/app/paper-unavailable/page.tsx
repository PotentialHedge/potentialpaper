export const dynamic = 'force-dynamic';

/** Where `proxy.ts` sends a new paper whose source is busy or down. The error page says so, uncached. */
export default function PaperUnavailable() {
  throw new Error('paper source unavailable');
}
