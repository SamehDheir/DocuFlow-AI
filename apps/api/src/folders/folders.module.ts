import { Module } from '@nestjs/common';
import { AuditModule } from '../common/audit/audit.module';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';

@Module({
  // AuditModule is not global — every module that records an action has to
  // import it explicitly, as AuthModule does.
  imports: [AuditModule],
  controllers: [FoldersController],
  providers: [FoldersService],
  exports: [FoldersService],
})
export class FoldersModule {}
