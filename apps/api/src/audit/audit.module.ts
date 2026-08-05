import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditQueryService } from './audit-query.service';

/**
 * The read side of the trail. `common/audit/AuditModule` is the write side and
 * is imported by every module that records an action; this one is a feature
 * module and imports nothing from it.
 */
@Module({
  controllers: [AuditController],
  providers: [AuditQueryService],
})
export class AuditQueryModule {}
