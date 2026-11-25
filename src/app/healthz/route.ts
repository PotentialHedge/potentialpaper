import { existsSync } from 'node:fs';
import { NextResponse } from 'next/server';
import { checkDatabase } from '@/db';

/** Made by `scripts/deploy-prod.sh` in the container it is about to stop, so Traefik routes nothing new to it. */
const DRAINING = '/tmp/draining';

export const dynamic = 'force-dynamic';

/**
 * Liveness AND readiness. It touches the database on purpose: a container that
 * is up with a dead connection pool is the failure you actually get, and a 200
 * that never reached Postgres would hide it from the uptime monitor.
 */
export async function GET() {
  if (existsSync(DRAINING)) {
    return NextResponse.json({ status: 'draining' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    await checkDatabase();
  } catch {
    return NextResponse.json(
      { status: 'error', database: 'unreachable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
