import { Module } from '@nestjs/common';
import { AuditModule } from '../common/audit/audit.module';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';

@Module({
  // AuditModule is not global — every module that records an action imports it.
  imports: [AuditModule],
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
