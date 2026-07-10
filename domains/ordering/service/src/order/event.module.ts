// Registers the order event handler on the event-handler container root.
//
// This module is imported by `EventsModule` (not `ApiModule`), so the
// `OrderEventController` routes only exist on the internal event-handler
// service.

import { Module } from '@nestjs/common';
import { OrderEventController } from './event.controller.js';
import { OrderFirestoreProjectionService } from './firestore-projection.service.js';

@Module({
  controllers: [OrderEventController],
  providers: [OrderFirestoreProjectionService],
})
export class OrderEventModule {}
