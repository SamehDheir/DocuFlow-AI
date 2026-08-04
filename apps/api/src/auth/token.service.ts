import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { CookieOptions } from 'express';
import { AuditService } from '../common/audit/audit.service';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import type { Env } from '../config/env.validation';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantGuardedClient, TenantTransactionClient } from '../prisma/tenant-guard';
import type { JwtPayload } from './auth.types';
import { durationToMs } from './duration';
import { digestToken } from './token-digest';

/** Cookie the browser round-trips; the access token stays in memory instead. */
export const REFRESH_COOKIE = 'docuflow_refresh';

/**
 * Carries no credential — only the fact that a session was started.
 *
 * REFRESH_COOKIE is scoped to /api/auth so it is never attached to document or
 * upload traffic, which also means the web app's proxy cannot see it when
 * deciding whether to let a navigation through to a protected page. This flag
 * is path-/ and exists solely for that decision.
 *
 * It is a hint, not an authorisation: it survives revocation, and a forged one
 * grants nothing. Every protected read is still checked by the API.
 */
export const SESSION_COOKIE = 'docuflow_session';

/**
 * How long after rotation a spent token is still forgiven rather than treated
 * as replay. Long enough to absorb concurrent tabs, far too short to be useful
 * to an attacker who has to steal the token first.
 */
const REUSE_LEEWAY_MS = 10_000;

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface TokenSubject {
  id: string;
  companyId: string;
  roles: string[];
}

/** What a successful rotation resolves to, before the session is rebuilt. */
export interface RotatedSession {
  userId: string;
  companyId: string;
  refreshToken: string;
}

type TokenWriter = Pick<TenantGuardedClient | TenantTransactionClient, 'refreshToken'>;

/**
 * Mints and rotates credentials.
 *
 * Access tokens are stateless JWTs; refresh tokens are opaque random strings
 * with a row behind them. The asymmetry is deliberate — a stateless refresh
 * token cannot be revoked, which would make logout cosmetic and leave a stolen
 * token valid for its full lifetime.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  private readonly accessSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshPepper: string;
  private readonly refreshTtlMs: number;
  private readonly isProduction: boolean;

  constructor(
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly tenant: TenantContextService,
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    config: ConfigService<Env, true>,
  ) {
    this.accessSecret = config.get('JWT_SECRET', { infer: true });
    // Seconds rather than the raw "15m": the signer types the string form as a
    // narrow literal union that a plain env string does not satisfy, and
    // parsing here fails at boot on a bad value instead of on the first login.
    this.accessTtlSeconds = durationToMs(config.get('JWT_EXPIRES_IN', { infer: true })) / 1000;
    this.refreshPepper = config.get('JWT_REFRESH_SECRET', { infer: true });
    this.refreshTtlMs = durationToMs(config.get('JWT_REFRESH_EXPIRES_IN', { infer: true }));
    this.isProduction = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  signAccessToken(subject: TokenSubject): Promise<string> {
    const payload: JwtPayload = {
      sub: subject.id,
      company_id: subject.companyId,
      roles: subject.roles,
    };

    return this.jwt.signAsync(payload, {
      secret: this.accessSecret,
      expiresIn: this.accessTtlSeconds,
    });
  }

  /**
   * Options for the refresh cookie.
   *
   * Scoped to /api/auth so it is never attached to document or upload requests,
   * which shrinks both the exposure surface and the bytes on every other call.
   * SameSite=lax is sufficient because the browser app and this API are served
   * from one origin in production (see docker/nginx/nginx.conf).
   */
  cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      // Also the CSRF defence for /auth/refresh and /auth/logout, which are
      // authenticated by this cookie alone: Lax withholds it from cross-site
      // POSTs, so another origin cannot drive either endpoint.
      sameSite: 'lax',
      secure: this.isProduction,
      path: '/api/auth',
      maxAge: this.refreshTtlMs,
    };
  }

  /**
   * Options for the path-/ presence flag. See SESSION_COOKIE.
   *
   * Deliberately readable by script, unlike the refresh cookie. The web app
   * checks it to decide whether a page load should attempt to restore a session
   * at all; without that it would have to call /auth/refresh on every anonymous
   * visit to find out. It holds no credential, so exposing it costs nothing.
   */
  sessionCookieOptions(): CookieOptions {
    return { ...this.cookieOptions(), path: '/', httpOnly: false };
  }

  /**
   * Issues a refresh token and persists its digest.
   *
   * Pass `familyId` to continue an existing rotation lineage; omit it to start
   * a new one, which is what a fresh login does.
   */
  async issueRefreshToken(
    subject: Pick<TokenSubject, 'id' | 'companyId'>,
    context: RequestContext = {},
    options: { familyId?: string; client?: TokenWriter } = {},
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const client = options.client ?? this.db;

    await client.refreshToken.create({
      data: {
        companyId: subject.companyId,
        userId: subject.id,
        tokenHash: this.digest(token),
        familyId: options.familyId ?? randomUUID(),
        expiresAt: new Date(Date.now() + this.refreshTtlMs),
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      },
    });

    return token;
  }

  /**
   * Exchanges a refresh token for its successor.
   *
   * Runs as system: a refresh arrives precisely when the access token has
   * expired, so there is no tenant context to scope the lookup by. The digest
   * is unique and unguessable, which is what makes that safe — the token itself
   * identifies the tenant.
   */
  async rotate(presented: string, context: RequestContext = {}): Promise<RotatedSession> {
    return this.tenant.runAsSystem(async () => {
      const tokenHash = this.digest(presented);
      const existing = await this.db.refreshToken.findUnique({ where: { tokenHash } });

      if (!existing) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      if (existing.revokedAt) {
        /**
         * Inside the leeway this is a race, not theft.
         *
         * Cookies are shared across a browser's tabs, so restoring several at
         * once sends the same token from each. One wins; the others arrive
         * moments later against a row that is already revoked. Treating that as
         * a breach would sign the user out everywhere for opening tabs — while
         * the losers simply retry and pick up the winner's cookie from the
         * shared jar.
         *
         * The cost is that an attacker replaying within seconds escapes family
         * revocation. They still get nothing: the response is 401 either way.
         */
        if (Date.now() - existing.revokedAt.getTime() > REUSE_LEEWAY_MS) {
          await this.handleReuse(existing.familyId, existing, context);
        }

        throw new UnauthorizedException('Invalid refresh token');
      }

      if (existing.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException('Refresh token expired');
      }

      return this.db.$transaction(async (tx) => {
        /**
         * Revoke conditionally so two requests racing with the same token
         * cannot both mint a successor. The loser is rejected but its family is
         * left intact: a genuine double-submit from two tabs is a race, not
         * theft, and signing the user out of every device for it would be
         * punishing normal behaviour. Replay after the fact is still caught —
         * by the `revokedAt` check above, on the next attempt.
         */
        const { count } = await tx.refreshToken.updateMany({
          where: { id: existing.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });

        if (count === 0) {
          throw new UnauthorizedException('Invalid refresh token');
        }

        const refreshToken = await this.issueRefreshToken(
          { id: existing.userId, companyId: existing.companyId },
          context,
          { familyId: existing.familyId, client: tx },
        );

        return { userId: existing.userId, companyId: existing.companyId, refreshToken };
      });
    });
  }

  /**
   * Revokes a presented token. Returns the session it belonged to so the caller
   * can audit the logout, or null when the token was already unusable.
   */
  async revoke(presented: string): Promise<{ userId: string; companyId: string } | null> {
    return this.tenant.runAsSystem(async () => {
      const tokenHash = this.digest(presented);
      const existing = await this.db.refreshToken.findUnique({ where: { tokenHash } });

      if (!existing || existing.revokedAt) {
        return null;
      }

      await this.db.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });

      return { userId: existing.userId, companyId: existing.companyId };
    });
  }

  /** Revokes every live token for a user — used when their password changes. */
  async revokeAllForUser(userId: string, client: TokenWriter = this.db): Promise<void> {
    await client.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * An already-rotated token came back. Either an attacker captured it and the
   * legitimate holder has since refreshed, or the reverse — and there is no way
   * to tell which from here. Both tokens are therefore treated as compromised
   * and the whole lineage is killed, forcing a real re-authentication.
   */
  private async handleReuse(
    familyId: string,
    token: { companyId: string; userId: string },
    context: RequestContext,
  ): Promise<void> {
    const { count } = await this.db.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    this.logger.warn(
      `Refresh token reuse detected for user ${token.userId}; revoked ${count} live token(s) in family ${familyId}`,
    );

    await this.audit.record({
      action: 'auth.refresh_reuse_detected',
      entityType: 'RefreshToken',
      entityId: familyId,
      companyId: token.companyId,
      userId: token.userId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { revokedTokens: count },
    });
  }

  private digest(token: string): string {
    return digestToken(token, this.refreshPepper);
  }
}
