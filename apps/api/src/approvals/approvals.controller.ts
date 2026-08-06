import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { contextOf } from '../common/http/request-context';
import { ApprovalsService } from './approvals.service';
import { DecideApprovalDto, ListApprovalsDto, RequestApprovalDto } from './dto/approval.dto';

@Controller()
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  /**
   * Raise a request. Needs `documents.update`, not `documents.approve` — asking
   * for sign-off is ordinary document work, and requiring the approve
   * permission would mean only approvers could ever start the workflow.
   */
  @Post('documents/:id/approval')
  @RequirePermissions('documents.update')
  request(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestApprovalDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.approvals.request(id, dto, user.sub, user.companyId, contextOf(request));
  }

  /** A document's approval history. */
  @Get('documents/:id/approval')
  @RequirePermissions('documents.read')
  forDocument(@Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.forDocument(id);
  }

  /**
   * The inbox. Readable by anyone who can read documents: seeing that a
   * document is awaiting sign-off is not privileged, deciding it is.
   */
  @Get('approvals')
  @RequirePermissions('documents.read')
  list(@Query() dto: ListApprovalsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.approvals.list(dto, user.sub);
  }

  /** The privileged half. */
  @Post('approvals/:id/decision')
  @RequirePermissions('documents.approve')
  decide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideApprovalDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.approvals.decide(id, dto, user.sub, user.companyId, contextOf(request));
  }

  /**
   * Withdrawing needs no approve permission — the service restricts it to the
   * requester, and someone who could raise a request can retract it.
   */
  @Post('approvals/:id/cancel')
  @RequirePermissions('documents.update')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.approvals.cancel(id, user.sub, user.companyId, contextOf(request));
  }
}
