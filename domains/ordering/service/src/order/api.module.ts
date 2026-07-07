// Registers the Order HTTP controller on the public API container root.
//
// `module.ts` holds the providers, this module wires the controller.
// `ApiModule` (the public API root) imports it, so the `/orders` routes live
// only on the public API service, not on the internal event-handler service.

import { Module } from '@nestjs/common';
import { OrderApiController } from './api.controller.js';
import { OrderModule } from './module.js';

@Module({
  imports: [OrderModule],
  controllers: [OrderApiController],
})
export class OrderApiModule {}
