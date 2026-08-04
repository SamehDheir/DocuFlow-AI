import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { TenantContextService } from './tenant-context.service';

/**
 * Binds tenant context for the duration of a request.
 *
 * The company is read from the authenticated principal that JwtMiddleware
 * attached — never from the request body, query string, or a header. A
 * client-supplied company_id would let any caller read any tenant's data simply
 * by changing a parameter, which is the single most likely way this system
 * could leak data.
 *
 * Anonymous requests bind nothing, so tenant-scoped queries fail closed. That
 * is correct rather than exceptional: registration, login, and refresh all run
 * before a tenant is known, and each opts into `runAsSystem()` deliberately.
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
