import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { compare, hash } from 'bcrypt';
import { AuditService } from '../common/audit/audit.service';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import type { Env } from '../config/env.validation';
import type { AcceptInvitationDto } from '../invitations/dto/invitation.dto';
import { InvitationsService } from '../invitations/invitations.service';
import { DEFAULT_ROLES, OWNER_ROLE } from '../permissions/permissions.catalogue';
import {
  PermissionsService,
  WITH_ROLE_PERMISSIONS,
  permissionsOf,
} from '../permissions/permissions.service';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import type { AuthResult, AuthenticatedUser, SessionUser } from './auth.types';
import type { ForgotPasswordDto } from './dto/forgot-password.dto';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import type { ResetPasswordDto } from './dto/reset-password.dto';
import { digestToken } from './token-digest';
import { TokenService, type RequestContext } from './token.service';

const WITH_ROLES = {
  roles: { select: { role: { select: { name: true } } } },
} satisfies Prisma.UserInclude;

type UserWithRoles = Prisma.UserGetPayload<{ include: typeof WITH_ROLES }>;

/**
 * One message for every login failure.
 *
 * Distinguishing "no such account" from "wrong password" hands an attacker a
 * free membership oracle, which is the same reason forgot-password always
 * answers 200.
 */
const INVALID_CREDENTIALS = 'Email or password is incorrect';

/** 30 minutes — the window the forgot-password screen promises the reader. */
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private readonly bcryptRounds: number;
  private readonly resetPepper: string;
  private readonly webOrigin: string;
  private readonly isProduction: boolean;

  /**
   * A throwaway hash to compare against when no account matches.
   *
   * Without it, an unknown address returns before bcrypt ever runs while a
   * known one pays for a full comparison, and the difference is large enough to
   * measure — which would leak exactly what the shared error message hides.
   * Computed once at startup, off the request path.
   */
  private readonly decoyHash: Promise<string>;

  constructor(
    private readonly tokens: TokenService,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
    private readonly tenant: TenantContextService,
    private readonly invitations: InvitationsService,
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    config: ConfigService<Env, true>,
  ) {
    this.bcryptRounds = config.get('BCRYPT_ROUNDS', { infer: true });
    this.resetPepper = config.get('JWT_REFRESH_SECRET', { infer: true });
    this.webOrigin = config.get('CORS_ORIGIN', { infer: true }).split(',')[0].trim();
    this.isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

    this.decoyHash = hash(randomBytes(24).toString('hex'), this.bcryptRounds);
  }

  /**
   * Creates a company, its starting roles, and its first user.
   *
   * Runs as system because there is no tenant yet — this is the request that
   * brings one into existence. Everything is one transaction: a company with no
   * Owner, or an Owner with no roles, is a tenant nobody can administer and
   * there is no repair path through the API.
   */
  async register(dto: RegisterDto, context: RequestContext): Promise<AuthResult> {
    const passwordHash = await hash(dto.password, this.bcryptRounds);
    const permissionIds = await this.permissions.idsByName(
      DEFAULT_ROLES.flatMap((role) => role.permissions),
    );

    const user = await this.tenant.runAsSystem(() =>
      this.db.$transaction(async (tx) => {
        await this.assertEmailAvailable(dto.email, tx);

        const company = await tx.company.create({
          data: { name: dto.companyName, slug: await this.uniqueSlug(dto.companyName, tx) },
        });

        const roles = await Promise.all(
          DEFAULT_ROLES.map((preset) =>
            tx.role.create({
              data: {
                companyId: company.id,
                name: preset.name,
                description: preset.description,
                permissions: {
                  create: preset.permissions
                    .map((name) => permissionIds.get(name))
                    .filter((id): id is string => id !== undefined)
                    .map((permissionId) => ({ permissionId })),
                },
              },
            }),
          ),
        );

        const owner = roles.find((role) => role.name === OWNER_ROLE);

        if (!owner) {
          throw new Error(`Default role "${OWNER_ROLE}" was not created`);
        }

        const created = await tx.user.create({
          data: {
            companyId: company.id,
            email: dto.email,
            passwordHash,
            firstName: dto.firstName,
            lastName: dto.lastName,
            roles: { create: { roleId: owner.id } },
          },
          include: WITH_ROLES,
        });

        await this.audit.record(
          {
            action: 'auth.register',
            entityType: 'Company',
            entityId: company.id,
            companyId: company.id,
            userId: created.id,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: { companyName: company.name, slug: company.slug },
          },
          tx,
        );

        return created;
      }),
    );

    return this.issueSession(user, context);
  }

  /**
   * Creates an account inside an existing company, from an invitation token.
   *
   * This is registration's other half. `register` necessarily creates a new
   * company — the tenant does not exist yet — so without this path a workspace
   * could never hold more than the person who opened it, and the role model
   * would have nothing to apply to.
   *
   * Runs as system for the same reason register does: an anonymous request has
   * no tenant bound, and the company being joined is discovered from the token
   * rather than supplied by the caller. Accepting `companyId` from the body is
   * exactly the cross-tenant hole the guard exists to prevent.
   */
  async acceptInvitation(dto: AcceptInvitationDto, context: RequestContext): Promise<AuthResult> {
    const passwordHash = await hash(dto.password, this.bcryptRounds);

    const user = await this.tenant.runAsSystem(async () => {
      const grant = await this.invitations.resolve(dto.token);

      return this.db.$transaction(async (tx) => {
        /**
         * Re-checked inside the transaction, against the invitation's company.
         * The invite was refused at creation if the address was already a
         * member, but that was a different request — someone may have joined in
         * between, and email is unique per company.
         */
        const taken = await tx.user.findFirst({
          where: { companyId: grant.companyId, email: grant.email },
          select: { id: true },
        });

        if (taken) {
          throw new ConflictException({
            message: 'An account with this email already exists. Sign in instead.',
            errors: { email: 'This email is already registered' },
          });
        }

        /**
         * Consumed by the same statement that checks it is still open, so two
         * people racing the same forwarded link cannot both get an account:
         * `updateMany` with the null guard matches one row exactly once.
         */
        const consumed = await tx.invitation.updateMany({
          where: { id: grant.id, acceptedAt: null, revokedAt: null },
          data: { acceptedAt: new Date() },
        });

        if (consumed.count === 0) {
          throw new BadRequestException('This invitation is invalid, expired, or already used');
        }

        const created = await tx.user.create({
          data: {
            companyId: grant.companyId,
            email: grant.email,
            passwordHash,
            firstName: dto.firstName,
            lastName: dto.lastName,
            roles: { create: { roleId: grant.roleId } },
          },
          include: WITH_ROLES,
        });

        await this.audit.record(
          {
            action: 'auth.invitation_accepted',
            entityType: 'User',
            entityId: created.id,
            companyId: grant.companyId,
            userId: created.id,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: { invitationId: grant.id },
          },
          tx,
        );

        return created;
      });
    });

    return this.issueSession(user, context);
  }

  async login(dto: LoginDto, context: RequestContext): Promise<AuthResult> {
    /**
     * Still a list, not a single row. Registration refuses a duplicate address,
     * but the constraint underneath is per company, so invitations will one day
     * put the same person in two tenants — and the check in register() is an
     * application-level one that a concurrent pair of signups could slip past.
     *
     * The password decides which account is meant. Where two genuinely share
     * one, the oldest wins; choosing a company explicitly needs a field the
     * login form does not have yet.
     */
    const candidates = await this.tenant.runAsSystem(() =>
      this.db.user.findMany({
        where: { email: dto.email },
        include: WITH_ROLES,
        orderBy: { createdAt: 'asc' },
      }),
    );

    let matched: UserWithRoles | undefined;

    for (const candidate of candidates) {
      if (await compare(dto.password, candidate.passwordHash)) {
        matched = candidate;
        break;
      }
    }

    if (!matched) {
      if (candidates.length === 0) {
        await compare(dto.password, await this.decoyHash);
        this.logger.warn(
          `Login attempt for unknown address from ${context.ipAddress ?? 'unknown'}`,
        );
      } else {
        // Only auditable once a company is known — an audit row cannot exist
        // without one, so unknown addresses leave a log line instead.
        await this.audit.record({
          action: 'auth.login_failed',
          entityType: 'User',
          entityId: candidates[0].id,
          companyId: candidates[0].companyId,
          userId: candidates[0].id,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        });
      }

      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!matched.isActive) {
      await this.audit.record({
        action: 'auth.login_blocked',
        entityType: 'User',
        entityId: matched.id,
        companyId: matched.companyId,
        userId: matched.id,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { reason: 'account deactivated' },
      });

      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    await this.audit.record({
      action: 'auth.login',
      entityType: 'User',
      entityId: matched.id,
      companyId: matched.companyId,
      userId: matched.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return this.issueSession(matched, context);
  }

  /** Trades a refresh token for a new pair. Rotation and reuse detection live in TokenService. */
  async refresh(presented: string, context: RequestContext): Promise<AuthResult> {
    const rotated = await this.tokens.rotate(presented, context);

    const user = await this.tenant.runAsSystem(() =>
      this.db.user.findUnique({ where: { id: rotated.userId }, include: WITH_ROLES }),
    );

    if (!user?.isActive) {
      // Deactivated mid-session: kill the lineage rather than let it keep
      // rotating, since the token just issued would otherwise stay usable.
      await this.tenant.runAsSystem(() => this.tokens.revokeAllForUser(rotated.userId));
      throw new UnauthorizedException('Session is no longer valid');
    }

    const accessToken = await this.tokens.signAccessToken({
      id: user.id,
      companyId: user.companyId,
      roles: roleNames(user),
    });

    return { accessToken, user: toSessionUser(user), refreshToken: rotated.refreshToken };
  }

  async logout(presented: string | undefined, context: RequestContext): Promise<void> {
    if (!presented) {
      return;
    }

    const session = await this.tokens.revoke(presented);

    if (session) {
      await this.audit.record({
        action: 'auth.logout',
        entityType: 'User',
        entityId: session.userId,
        companyId: session.companyId,
        userId: session.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });
    }
  }

  /**
   * Issues a reset grant, and says nothing about whether the address exists.
   *
   * The caller always sees the same 200. Answering 404 for unknown addresses
   * would turn this endpoint into a way to test which emails have accounts.
   */
  async forgotPassword(dto: ForgotPasswordDto, context: RequestContext): Promise<void> {
    await this.tenant.runAsSystem(async () => {
      const users = await this.db.user.findMany({
        where: { email: dto.email, isActive: true },
      });

      for (const user of users) {
        // Supersede outstanding grants: requesting a new link should retire the
        // previous one, so a link forwarded or leaked earlier stops working.
        await this.db.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        });

        const token = randomBytes(32).toString('base64url');

        await this.db.passwordResetToken.create({
          data: {
            companyId: user.companyId,
            userId: user.id,
            tokenHash: digestToken(token, this.resetPepper),
            expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
          },
        });

        this.announceResetLink(user.email, token);

        await this.audit.record({
          action: 'auth.password_reset_requested',
          entityType: 'User',
          entityId: user.id,
          companyId: user.companyId,
          userId: user.id,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        });
      }
    });
  }

  async resetPassword(dto: ResetPasswordDto, context: RequestContext): Promise<void> {
    const passwordHash = await hash(dto.password, this.bcryptRounds);

    await this.tenant.runAsSystem(async () => {
      const grant = await this.db.passwordResetToken.findUnique({
        where: { tokenHash: digestToken(dto.token, this.resetPepper) },
      });

      if (!grant || grant.usedAt || grant.expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('This reset link is invalid or has expired');
      }

      await this.db.$transaction(async (tx) => {
        await tx.passwordResetToken.update({
          where: { id: grant.id },
          data: { usedAt: new Date() },
        });

        await tx.user.update({
          where: { id: grant.userId },
          data: { passwordHash },
        });

        /**
         * Every existing session dies with the old password. A reset is the
         * remedy for a suspected compromise, so leaving the attacker's refresh
         * token alive would defeat the point of it.
         */
        await this.tokens.revokeAllForUser(grant.userId, tx);

        await this.audit.record(
          {
            action: 'auth.password_reset_completed',
            entityType: 'User',
            entityId: grant.userId,
            companyId: grant.companyId,
            userId: grant.userId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
          },
          tx,
        );
      });
    });
  }

  /** Session hydration. Runs inside bound tenant context, so the guard scopes it. */
  async me(principal: AuthenticatedUser) {
    const user = await this.db.user.findUnique({
      where: { id: principal.sub },
      include: {
        company: { select: { id: true, name: true, slug: true } },
        ...WITH_ROLE_PERMISSIONS,
      },
    });

    if (!user?.isActive) {
      throw new UnauthorizedException('Session is no longer valid');
    }

    return {
      ...toSessionUser(user),
      company: user.company,
      roles: user.roles.map((link) => link.role.name),
      permissions: [...permissionsOf(user)].sort(),
    };
  }

  private async issueSession(user: UserWithRoles, context: RequestContext): Promise<AuthResult> {
    const [accessToken, refreshToken] = await Promise.all([
      this.tokens.signAccessToken({
        id: user.id,
        companyId: user.companyId,
        roles: roleNames(user),
      }),
      this.tenant.runAsSystem(() =>
        this.tokens.issueRefreshToken({ id: user.id, companyId: user.companyId }, context),
      ),
    ]);

    return { accessToken, user: toSessionUser(user), refreshToken };
  }

  /**
   * Refuses to open a second company for an address that already has an account.
   *
   * The database constraint is `@@unique([companyId, email])` — per company, not
   * global — because one person may legitimately belong to two customers. That
   * membership is meant to arrive by invitation into an EXISTING company
   * (`users.invite`), though. Self-service registration reaching the same state
   * is not the same thing: it silently forks the account, and the address then
   * matches several rows at login with only the password to tell them apart.
   *
   * Checked in application code rather than by a global unique index, since such
   * an index would also block the invitation flow this leaves room for.
   *
   * KNOWN TRADEOFF: an explicit conflict confirms that an address is registered.
   * The alternative — always answering 200 and settling it by email — needs a
   * mailer, which is not in the stack. The signup form is also the one place a
   * user genuinely needs to be told, so the disclosure is deliberate here in a
   * way it is not on login or forgot-password, both of which stay silent.
   */
  private async assertEmailAvailable(
    email: string,
    tx: Pick<TenantGuardedClient, 'user'>,
  ): Promise<void> {
    const existing = await tx.user.findFirst({ where: { email }, select: { id: true } });

    if (existing) {
      throw new ConflictException({
        message: 'An account with this email already exists. Sign in instead.',
        errors: { email: 'This email is already registered' },
      });
    }
  }

  /**
   * Derives a URL-safe slug, falling back to a generated one.
   *
   * Non-Latin company names are expected here — the product ships in Arabic —
   * and stripping to ASCII would leave most of them empty, so letters and
   * digits of any script are kept.
   */
  private async uniqueSlug(
    name: string,
    tx: Pick<TenantGuardedClient, 'company'>,
  ): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'company';

    let slug = base;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const taken = await tx.company.findUnique({ where: { slug }, select: { id: true } });

      if (!taken) {
        return slug;
      }

      slug = `${base}-${randomBytes(3).toString('hex')}`;
    }

    return `${base}-${randomBytes(8).toString('hex')}`;
  }

  /**
   * No mailer is in the stack yet, so the link goes to the log in development
   * and is withheld in production — a reset token in a production log file is a
   * credential sitting in plain text wherever those logs are shipped.
   */
  private announceResetLink(email: string, token: string): void {
    if (this.isProduction) {
      this.logger.log(`Password reset requested for ${email}; delivery is not configured`);
      return;
    }

    this.logger.log(`Password reset for ${email}: ${this.webOrigin}/reset-password?token=${token}`);
  }
}

function roleNames(user: UserWithRoles): string[] {
  return user.roles.map((link) => link.role.name);
}

function toSessionUser(user: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  companyId: string;
}): SessionUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    companyId: user.companyId,
  };
}
