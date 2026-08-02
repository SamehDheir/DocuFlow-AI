import { NextResponse } from 'next/server';

/**
 * Health probe for the web container.
 *
 * docker/web.Dockerfile's HEALTHCHECK targets GET /api/health, so this route
 * must keep that exact path.
 *
 * It reports only whether this Next.js server is up. It deliberately does not
 * probe the API — the web tier being reachable and the backend being reachable
 * are separate failures, and conflating them would make Docker restart a
 * perfectly healthy frontend during an API outage.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}
