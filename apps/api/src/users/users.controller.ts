import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { contextOf } from '../common/http/request-context';
import { SetRolesDto } from './dto/set-roles.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('users.read')
  list() {
    return this.users.list();
  }

  /**
   * PUT rather than PATCH: the body is the member's complete set of roles, so
   * repeating the call is idempotent and two administrators cannot interleave
   * into a combination neither of them chose.
   *
   * Gated on `roles.manage`, not `users.update`. Editing someone's name and
   * granting them authority are different powers — Admin holds the first and
   * deliberately not the second, or the distinction from Owner would be
   * meaningless.
   */
  @Put(':id/roles')
  @RequirePermissions('roles.manage')
  setRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRolesDto,
    @Req() request: Request,
  ) {
    return this.users.setRoles(id, dto.roleIds, contextOf(request));
  }
}
