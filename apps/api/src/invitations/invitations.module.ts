import { Module } from '@nestjs/common';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

/**
 * Exports the service because AuthService consumes it: accepting an invitation
 * creates an account and issues a session, which is authentication's job, but
 * the rule for what makes a token valid belongs here beside the one that
 * issued it.
 */
@Module({
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
