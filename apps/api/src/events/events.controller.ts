import { Controller, Sse } from '@nestjs/common';
import { type Observable, map, merge, timer } from 'rxjs';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { EventsService } from './events.service';
import type { LiveEvent } from './events.types';

/**
 * The live update stream.
 *
 * No @RequirePermissions: this carries only events the caller is already
 * entitled to — their own notifications, and status changes for documents in
 * their own company. JwtAuthGuard still applies, as it does to every route by
 * default, so the stream is authenticated.
 *
 * AUTHENTICATION NOTE: the browser does NOT use EventSource here. EventSource
 * cannot set headers, which would force the access token into the query string
 * and therefore into every nginx access log. The web client reads this with
 * fetch + ReadableStream instead, so it sends a normal Authorization header and
 * reuses the session's 401-renew-and-replay path. See lib/event-stream.ts.
 */
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Sse()
  stream(@CurrentUser() user: AuthenticatedUser): Observable<{ data: LiveEvent }> {
    return merge(
      this.events.stream(user.companyId, user.sub),
      /**
       * Heartbeat. nginx closes a connection with no traffic after
       * proxy_read_timeout, and a browser cannot tell a dropped stream from a
       * quiet one. 25s stays comfortably inside any sane proxy timeout.
       */
      timer(25_000, 25_000).pipe(map((): LiveEvent => ({ type: 'ping' }))),
    ).pipe(map((event) => ({ data: event })));
  }
}
