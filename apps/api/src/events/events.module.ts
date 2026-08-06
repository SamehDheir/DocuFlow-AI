import { Global, Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

/**
 * Global: anything that changes state a user is watching may want to announce
 * it — the processing worker, approvals, notifications — and none of those
 * should have to import a module to do so.
 */
@Global()
@Module({
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
