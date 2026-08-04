import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { AuditQueryService } from './audit-query.service';
import { ListAuditDto } from './dto/list-audit.dto';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  /**
   * Declared before the collection route for the same reason
   * DocumentsController declares `stats` first — Nest matches in declaration
   * order, and a static segment placed after a parameterised one is
   * unreachable. There is no `:id` route here yet, but the ordering keeps that
   * from becoming a trap when one is added.
   */
  @Get('actions')
  @RequirePermissions('audit.read')
  actions() {
    return this.audit.actions();
  }

  @Get()
  @RequirePermissions('audit.read')
  list(@Query() query: ListAuditDto) {
    return this.audit.list(query);
  }
}
