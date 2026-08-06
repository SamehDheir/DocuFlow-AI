import { Module } from '@nestjs/common';
import { AuditModule } from '../common/audit/audit.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // Changing who holds which role is exactly the kind of mutation the audit
  // trail exists for — "who granted this person Admin" is unanswerable without
  // it.
  imports: [AuditModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
