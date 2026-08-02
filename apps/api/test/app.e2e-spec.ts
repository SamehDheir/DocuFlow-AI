import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

/**
 * End-to-end tests boot the real AppModule, which validates the environment and
 * connects to Postgres. They therefore need the local stack running:
 *
 *   npm run infra:up
 *
 * Run with `npm run test:e2e --workspace=@docuflow/api`. These are NOT part of
 * `npm test` (jest's rootDir is src/), and CI does not run them yet.
 */
describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health'] });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /health reports database connectivity', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    // supertest types `body` as any; narrow it so the assertions are type-checked.
    const body = response.body as {
      status: string;
      checks: Record<string, string>;
    };

    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('up');
  });

  it('keeps /health outside the /api prefix', async () => {
    // The Dockerfile HEALTHCHECK targets /health specifically; if the global
    // prefix ever swallows it, container health checks fail in production while
    // the app itself is fine.
    await request(app.getHttpServer()).get('/api/health').expect(404);
  });
});
