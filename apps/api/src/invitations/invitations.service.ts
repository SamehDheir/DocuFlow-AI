import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { digestToken } from '../auth/token-digest';
import { AuditService } from '../common/audit/audit.service';
import type { RequestContext } from '../common/http/request-context';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import type { Env } from '../config/env.validation';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { tenantCreate, type TenantGuardedClient } from '../prisma/tenant-guard';
import type { CreateInvitationDto } from './dto/invitation.dto';

/**
 * Seven days. Long enough to survive a weekend and a forwarded message, short
 * enough that a link found in an old inbox is no longer a way in. Matches the
 * reasoning behind the password-reset TTL, at a longer horizon because an
 * invitation is expected rather than urgent.
 */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const INVITATION = {
  id: true,
  email: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
  role: { select: { id: true, name: true } },
  invitedBy: { select: { firstName: true, lastName: true } },
} as const;

export interface InvitationView {
  id: string;
  email: string;
  role: { id: string; name: string };
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  invitedBy: string | null;
  expiresAt: Date;
  createdAt: Date;
}

/** What the accept screen may know before anyone has authenticated. */
export interface InvitationPreview {
  email: string;
  companyName: string;
  roleName: string;
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);
  private readonly pepper: string;
  private readonly webOrigin: string;
  private readonly isProduction: boolean;

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    private readonly audit: AuditService,
    private readonly tenant: TenantContextService,
    config: ConfigService<Env, true>,
  ) {
    // The same key the refresh and reset digests use. One secret guards every
    // credential this system stores but never reads back.
    this.pepper = config.get('JWT_REFRESH_SECRET', { infer: true });
    this.webOrigin = config.get('CORS_ORIGIN', { infer: true }).split(',')[0].trim();
    this.isProduction = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  /**
   * Issues a link that grants one person one role in this company.
   *
   * Returns the link to the caller rather than only logging it. There is no
   * mailer in this stack, so the inviter is the delivery mechanism — hiding the
   * token from the very administrator who created it would make the feature
   * unusable rather than more secure, and they already hold `users.invite`.
   */
  async create(
    dto: CreateInvitationDto,
    context: RequestContext,
  ): Promise<{ invitation: InvitationView; link: string }> {
    const email = dto.email.trim().toLowerCase();

    /**
     * Scoped by the guard, so this only ever finds a colleague. Someone with
     * this address at another company is irrelevant — email is unique per
     * company, not globally.
     */
    const existing = await this.db.user.findFirst({
      where: { email },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException({
        message: 'Someone with this email is already a member of this company',
        errors: { email: 'Already a member' },
      });
    }

    const role = await this.db.role.findFirst({
      where: { id: dto.roleId },
      select: { id: true, name: true },
    });

    if (!role) {
      throw new BadRequestException('That role does not exist in this company');
    }

    const token = randomBytes(32).toString('base64url');

    const invitation = await this.db.$transaction(async (tx) => {
      /**
       * Supersede outstanding invitations for the same address, exactly as
       * requesting a new reset link retires the previous one. Re-inviting
       * someone should not leave two live links, one of which the inviter has
       * forgotten about.
       */
      await tx.invitation.updateMany({
        where: { email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const created = await tx.invitation.create({
        // The guard stamps companyId at runtime; this is the sanctioned
        // assertion that lets Prisma's static types accept its absence.
        data: tenantCreate({
          email,
          roleId: role.id,
          tokenHash: digestToken(token, this.pepper),
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
          invitedById: this.tenant.getUserId() ?? null,
        }),
        select: INVITATION,
      });

      await this.audit.record(
        {
          action: 'users.invited',
          entityType: 'Invitation',
          entityId: created.id,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: { email, role: role.name },
        },
        tx,
      );

      return created;
    });

    this.announce(email);

    return { invitation: toView(invitation), link: this.linkFor(token) };
  }

  /** Outstanding and historical invitations, newest first. */
  async list(): Promise<{ items: InvitationView[]; total: number }> {
    const rows = await this.db.invitation.findMany({
      select: INVITATION,
      orderBy: { createdAt: 'desc' },
    });

    return { items: rows.map(toView), total: rows.length };
  }

  async revoke(id: string, context: RequestContext): Promise<InvitationView> {
    const invitation = await this.db.invitation.findFirst({
      where: { id },
      select: { id: true, email: true, acceptedAt: true, revokedAt: true },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.acceptedAt) {
      throw new BadRequestException('That invitation has already been accepted');
    }

    const updated = await this.db.$transaction(async (tx) => {
      const row = await tx.invitation.update({
        where: { id },
        data: { revokedAt: invitation.revokedAt ?? new Date() },
        select: INVITATION,
      });

      await this.audit.record(
        {
          action: 'users.invitation_revoked',
          entityType: 'Invitation',
          entityId: id,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: { email: invitation.email },
        },
        tx,
      );

      return row;
    });

    return toView(updated);
  }

  /**
   * What the accept screen shows before anyone has signed in.
   *
   * Runs as system: there is no tenant context on an anonymous request, and the
   * whole point is to discover which company the token belongs to. The token IS
   * the authorisation — nothing here is reachable without holding it.
   *
   * Deliberately narrow. It answers "which company, which role, which address"
   * and nothing else, because an invitation link is a bearer credential that
   * may have been forwarded.
   */
  async preview(token: string): Promise<InvitationPreview> {
    return this.tenant.runAsSystem(async () => {
      const invitation = await this.db.invitation.findUnique({
        where: { tokenHash: digestToken(token, this.pepper) },
        select: {
          email: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          company: { select: { name: true } },
          role: { select: { name: true } },
        },
      });

      if (!isUsable(invitation)) {
        throw new BadRequestException('This invitation is invalid, expired, or already used');
      }

      return {
        email: invitation.email,
        companyName: invitation.company.name,
        roleName: invitation.role.name,
      };
    });
  }

  /**
   * Resolves a token to the grant it represents, for AuthService to consume.
   *
   * Kept here rather than in auth so the digest key, the TTL and the
   * usable/expired rule live in one file — accepting has to agree with
   * previewing about what "valid" means, and two copies of that rule would
   * eventually disagree.
   */
  async resolve(token: string): Promise<{
    id: string;
    companyId: string;
    email: string;
    roleId: string;
  }> {
    const invitation = await this.db.invitation.findUnique({
      where: { tokenHash: digestToken(token, this.pepper) },
      select: {
        id: true,
        companyId: true,
        email: true,
        roleId: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
      },
    });

    if (!isUsable(invitation)) {
      throw new BadRequestException('This invitation is invalid, expired, or already used');
    }

    return {
      id: invitation.id,
      companyId: invitation.companyId,
      email: invitation.email,
      roleId: invitation.roleId,
    };
  }

  private linkFor(token: string): string {
    return `${this.webOrigin}/invite?token=${token}`;
  }

  /**
   * Mirrors `announceResetLink`. In development the link is logged so the flow
   * is walkable without a mailer; in production it is withheld from the log,
   * because the response already carried it to the one person entitled to it.
   */
  private announce(email: string): void {
    this.logger.log(
      this.isProduction
        ? `Invitation created for ${email}; delivery is not configured`
        : `Invitation created for ${email}; the link is in the API response`,
    );
  }
}

/** Shared by preview and resolve so the two cannot disagree about validity. */
function isUsable<T extends { expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null }>(
  invitation: T | null,
): invitation is T {
  return Boolean(
    invitation &&
    !invitation.acceptedAt &&
    !invitation.revokedAt &&
    invitation.expiresAt.getTime() > Date.now(),
  );
}

function toView(row: {
  id: string;
  email: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  role: { id: string; name: string };
  invitedBy: { firstName: string; lastName: string } | null;
}): InvitationView {
  /**
   * Expiry is derived on read rather than stored. A row does not change when
   * the clock passes its deadline, and a status column would need a sweeper to
   * stay honest.
   */
  const status = row.acceptedAt
    ? 'ACCEPTED'
    : row.revokedAt
      ? 'REVOKED'
      : row.expiresAt.getTime() <= Date.now()
        ? 'EXPIRED'
        : 'PENDING';

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status,
    invitedBy: row.invitedBy ? `${row.invitedBy.firstName} ${row.invitedBy.lastName}` : null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}
