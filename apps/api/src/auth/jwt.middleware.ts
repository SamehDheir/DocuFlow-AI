import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Response } from 'express';
import type { Env } from '../config/env.validation';
import type { AuthenticatedRequest, JwtPayload } from './auth.types';

/**
 * Resolves the access token into `req.user`.
 *
 * This is MIDDLEWARE, not a guard, and that is the whole point. Nest's request
 * lifecycle is middleware → guards → interceptors → pipes → handler, while
 * TenantMiddleware needs an authenticated principal to bind tenant context —
 * and it must do so in middleware, because it wraps `next()` in the
 * AsyncLocalStorage scope that has to cover the entire request. A conventional
 * JwtAuthGuard would run too late to feed it.
 *
 * So the responsibility is split: this resolves identity and NEVER rejects,
 * JwtAuthGuard decides whether a route tolerates the absence of one.
 */
@Injectable()
export class JwtMiddleware implements NestMiddleware {
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('JWT_SECRET', { infer: true });
  }

  use(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
    const header = req.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      next();
      return;
    }

    try {
      const payload = this.jwt.verify<JwtPayload>(header.slice('Bearer '.length), {
        secret: this.secret,
      });

      req.user = {
        sub: payload.sub,
        companyId: payload.company_id,
        roles: payload.roles ?? [],
      };
    } catch {
      // Expired or forged: leave the request anonymous. Turning this into a 401
      // here would also reject /auth/refresh, whose entire purpose is to be
      // called with an access token that has just expired.
    }

    next();
  }
}
