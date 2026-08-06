import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
import type { RequestContext } from '../common/http/request-context';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { OWNER_ROLE } from '../permissions/permissions.catalogue';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantGuardedClient } from '../prisma/tenant-guard';

/**
 * Colleagues within the current company.
 *
 * Read-only in v1. `users.invite` and `users.update` are in the catalogue but
 * deliberately unconsumed — inviting and editing people is v2 scope.
 */

/**
 * `passwordHash` is absent by construction.
 *
 * An explicit select rather than `include`, so a column added to the model
 * later cannot silently start appearing in an API response.
 */
const MEMBER = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  isActive: true,
  createdAt: true,
  /**
   * Reached through User, never by querying UserRole directly: that join table
   * carries no companyId of its own and the tenant guard passes it through
   * unfiltered. Same reasoning as PermissionsService.effectiveFor().
   */
  roles: { select: { role: { select: { name: true } } } },
} as const;

export interface MemberView {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  isActive: boolean;
  createdAt: Date;
  roles: string[];
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    private readonly audit: AuditService,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Every member of the company, active first, then by name.
   *
   * No cursor here, unlike documents and audit: a company's headcount is
   * bounded in a way its archive is not, and the dashboard wants the total
   * anyway. If a tenant ever grows past a page of this, it earns pagination
   * then.
   */
  async list(): Promise<{ items: MemberView[]; total: number }> {
    const rows = await this.db.user.findMany({
      select: MEMBER,
      orderBy: [{ isActive: 'desc' }, { firstName: 'asc' }, { lastName: 'asc' }],
    });

    const items = rows.map((row) => ({
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      isActive: row.isActive,
      createdAt: row.createdAt,
      roles: row.roles.map((link) => link.role.name),
    }));

    return { items, total: items.length };
  }

  /**
   * Replaces a member's roles wholesale.
   *
   * A set, not a delta: "these are their roles now" is one statement the caller
   * can reason about, where add/remove endpoints let two concurrent edits
   * interleave into a combination neither administrator chose.
   *
   * Every id is checked against the company's own roles before anything is
   * written. The tenant guard scopes the lookup, so a role id belonging to
   * another company simply will not be found — the request fails rather than
   * silently granting nothing, because a caller who names a role that does not
   * exist has not got what they asked for.
   */
  async setRoles(userId: string, roleIds: string[], context: RequestContext): Promise<MemberView> {
    const unique = [...new Set(roleIds)];

    if (unique.length === 0) {
      throw new BadRequestException('A member must hold at least one role');
    }

    const member = await this.db.user.findFirst({
      where: { id: userId },
      select: { id: true, roles: { select: { role: { select: { id: true, name: true } } } } },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    const roles = await this.db.role.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });

    if (roles.length !== unique.length) {
      throw new BadRequestException('One or more roles do not exist in this company');
    }

    await this.assertOwnerSurvives(member, roles);

    const updated = await this.db.$transaction(async (tx) => {
      /**
       * Delete-then-insert rather than a diff. UserRole's primary key is the
       * pair, so there is no row to update, and computing the difference would
       * be more code for the same two statements.
       *
       * UserRole carries no companyId of its own — the guard cannot scope it —
       * which is why `member` was loaded through User first: that read is
       * scoped, so reaching this line at all proves the user is ours.
       */
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userRole.createMany({
        data: roles.map((role) => ({ userId, roleId: role.id })),
      });

      await this.audit.record(
        {
          action: 'users.roles_changed',
          entityType: 'User',
          entityId: userId,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: {
            from: member.roles.map((link) => link.role.name).sort(),
            to: roles.map((role) => role.name).sort(),
          },
        },
        tx,
      );

      return tx.user.findFirstOrThrow({ where: { id: userId }, select: MEMBER });
    });

    return {
      id: updated.id,
      firstName: updated.firstName,
      lastName: updated.lastName,
      email: updated.email,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
      roles: updated.roles.map((link) => link.role.name),
    };
  }

  /**
   * Refuses the edit that locks everyone out of their own workspace.
   *
   * Owner is the only role holding `roles.manage`, so demoting the last one
   * leaves a company nobody can ever administer again — and unlike most
   * mistakes there is no repair path through the API, only a database. The
   * check counts holders rather than trusting the caller not to be the last
   * one, because an Owner demoting a *colleague* is the same danger.
   */
  private async assertOwnerSurvives(
    member: { id: string; roles: { role: { id: string; name: string } }[] },
    next: { id: string; name: string }[],
  ): Promise<void> {
    const wasOwner = member.roles.some((link) => link.role.name === OWNER_ROLE);
    const staysOwner = next.some((role) => role.name === OWNER_ROLE);

    if (!wasOwner || staysOwner) return;

    const owners = await this.db.user.count({
      where: { isActive: true, roles: { some: { role: { name: OWNER_ROLE } } } },
    });

    if (owners <= 1) {
      throw new BadRequestException(
        'This is the last Owner — promote someone else before changing this role',
      );
    }
  }
}
