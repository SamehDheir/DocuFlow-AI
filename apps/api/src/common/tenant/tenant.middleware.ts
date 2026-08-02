import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TenantContextService } from './tenant-context.service';

/**
 * Shape the auth layer is expected to attach to the request once JWT
 * validation exists.
 */
interface AuthenticatedRequest extends Request {
  user?: { sub: string; companyId: string };
}

/**
 * Binds tenant context for the duration of a request.
 *
 * The company is read from the authenticated principal — never from the request
 * body, query string, or a header. A client-supplied company_id would let any
 * caller read any tenant's data simply by changing a parameter, which is the
 * single most likely way this system could leak data.
 *
 * STATUS: authentication is not implemented yet, so `req.user` is always
 * undefined and no context is bound. Tenant-scoped Prisma queries therefore
 * throw — the intended fail-closed behaviour until the JWT guard lands and
 * populates `req.user`.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly tenantContext: TenantContextService) {}

  use(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
    const user = req.user;

    if (!user?.companyId) {
      next();
      return;
    }

    this.tenantContext.run({ companyId: user.companyId, userId: user.sub }, next);
  }
}
