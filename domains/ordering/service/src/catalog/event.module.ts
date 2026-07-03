// Registers the catalogue event handler on the event-handler container root.
//
// This module is imported by `EventsModule` (not `ApiModule`), so the
// `CatalogEventController` route only exists on the internal event-handler
// service.

import { Module } from '@nestjs/common';
import { CatalogEventController } from './event.controller.js';
import { CatalogModule } from './module.js';

@Module({
  imports: [CatalogModule],
  controllers: [CatalogEventController],
})
export class CatalogEventModule {}
