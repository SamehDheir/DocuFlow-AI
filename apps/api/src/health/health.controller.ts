import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

interface HealthResponse {
  status: 'ok' | 'degraded';
  uptime: number;
  timestamp: string;
  checks: Record<string, 'up' | 'down'>;
}

/**
 * Liveness/readiness probe.
 *
 * Mounted at GET /health, OUTSIDE the /api global prefix — docker/api.Dockerfile's
 * HEALTHCHECK and docker-compose.prod.yml both target that exact path.
 *
 * Always returns HTTP 200, with the real state in the body. A non-200 would make
 * Docker restart the container on a transient database blip, turning a
 * recoverable dependency failure into a crash loop.
 *
 * Unauthenticated: Docker's HEALTHCHECK has no credentials to present, and a
 * probe that 401s reads as an unhealthy container.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const checks: Record<string, 'up' | 'down'> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      checks.database = 'down';
    }

    const allUp = Object.values(checks).every((state) => state === 'up');

    return {
      status: allUp ? 'ok' : 'degraded',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      checks,
    };
  }
}
