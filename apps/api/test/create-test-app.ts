import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';

/**
 * Boots the real application the way main.ts does.
 *
 * The global prefix, validation pipe, and cookie parser are all bootstrap
 * concerns rather than module ones, so a test that skips them exercises a
 * different application than the one that ships — and the differences (a
 * missing pipe, an unparsed refresh cookie) are exactly where auth bugs hide.
 */
export async function createTestApp(): Promise<NestExpressApplication> {
  const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleFixture.createNestApplication<NestExpressApplication>();

  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  await app.init();

  return app;
}
