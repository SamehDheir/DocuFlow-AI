import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { Env } from './config/env.validation';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
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
