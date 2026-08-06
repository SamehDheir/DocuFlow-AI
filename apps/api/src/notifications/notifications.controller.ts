import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { NotificationsService } from './notifications.service';

/**
 * The caller's own inbox.
 *
 * NO @RequirePermissions ANYWHERE IN THIS FILE, deliberately. Reading your own
 * notifications is not a privilege a role grants — every authenticated user has
 * an inbox, and gating it behind a permission would allow a configuration where
 * someone is notified but cannot look.
 *
 * The property that matters here is addressing, not authorisation: every method
 * takes the user id from the verified JWT, and no route accepts one as a
 * parameter. The tenant guard scopes rows to the company; `userId` is what
 * separates colleagues inside it.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Query() query: ListNotificationsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.list(user.sub, {
      cursor: query.cursor,
      limit: query.limit,
      unreadOnly: query.unreadOnly === 'true',
    });
  }

  /** Kept separate so the bell badge can refresh without fetching a page of rows. */
  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return { unread: await this.notifications.unreadCount(user.sub) };
  }

  @Post('read-all')
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.sub);
  }

  @Post(':id/read')
  markRead(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markRead(id, user.sub);
  }
}
