import { Module } from '@nestjs/common';
import { AuditModule } from '../common/audit/audit.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  /**
   * AuditModule is not global — every module that records an action imports it.
   * PermissionsModule is here because deleting someone else's comment is an
   * either/or the route decorator cannot express, so the service asks for the
   * caller's effective permissions itself.
   */
  imports: [AuditModule, PermissionsModule],
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
