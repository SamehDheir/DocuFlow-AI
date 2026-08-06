import { Module } from '@nestjs/common';
import { AuditModule } from '../common/audit/audit.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

/**
 * Exports the service because AuthService consumes it: accepting an invitation
 * creates an account and issues a session, which is authentication's job, but
 * the rule for what makes a token valid belongs here beside the one that
 * issued it.
 *
 * AuditModule is imported rather than assumed: TENANT_PRISMA and
 * TenantContextService arrive from the @Global PrismaModule, but AuditService
 * does not, and issuing or revoking an invitation is exactly the kind of
 * mutation the trail exists for.
 */
@Module({
  imports: [AuditModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
