import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsString } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { contextOf } from '../common/http/request-context';
import { CreateInvitationDto } from './dto/invitation.dto';
import { InvitationsService } from './invitations.service';

class PreviewInvitationDto {
  @IsString()
  token!: string;
}

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @RequirePermissions('users.invite')
  create(@Body() dto: CreateInvitationDto, @Req() request: Request) {
    return this.invitations.create(dto, contextOf(request));
  }

  @Get()
  @RequirePermissions('users.invite')
  list() {
    return this.invitations.list();
  }

  @Delete(':id')
  @RequirePermissions('users.invite')
  revoke(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.invitations.revoke(id, contextOf(request));
  }

  /**
   * Public, because the person holding the link has no account yet — that is
   * what they are here to create. The token is the credential.
   *
   * POST with the token in the body rather than GET with it in the path: an
   * invitation token is a bearer credential, and a path lands in every access
   * log and proxy trace between here and the browser.
   */
  @Public()
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(@Body() dto: PreviewInvitationDto) {
    return this.invitations.preview(dto.token);
  }
}
