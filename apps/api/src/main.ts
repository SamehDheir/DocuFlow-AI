import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import type { Env } from './config/env.validation';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService<Env, true>);

  /**
   * Application routes live under /api, matching docker/nginx/nginx.conf, which
   * proxies /api/ to this service without rewriting the path.
   *
   * `health` is excluded so the probe stays at /health — the path baked into
   * the Dockerfile HEALTHCHECK.
   */
  app.setGlobalPrefix('api', { exclude: ['health'] });

  app.enableCors({
    origin: config.get('CORS_ORIGIN', { infer: true }),
    credentials: true,
  });

  // The refresh token travels as an httpOnly cookie, which has to be parsed
  // before any handler can read it. `credentials: true` above is the other half
  // of that arrangement.
  app.use(cookieParser());

  /**
   * Behind nginx (docker/nginx/nginx.conf), the client address arrives in
   * X-Forwarded-For and req.ip would otherwise report the proxy on every audit
   * row. Trust is limited to production because in development nothing sits in
   * front of this process, and an unconditional trust would let any caller
   * forge the IP recorded against their actions.
   */
  if (config.get('NODE_ENV', { infer: true }) === 'production') {
    app.set('trust proxy', 1);
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Reject unknown properties outright instead of silently dropping them,
      // so a client sending company_id gets an error rather than the false
      // impression that it was honoured.
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Lets Docker stop the container without severing in-flight uploads.
  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');

  Logger.log(`API listening on http://localhost:${port}/api`, 'Bootstrap');
  Logger.log(`Health probe at http://localhost:${port}/health`, 'Bootstrap');
}

void bootstrap();
