// The `order` feature module: providers for the Ordering domain's own entity.

import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/module.js';
import { OrderAuthorizationService } from './authorization.service.js';
import { OrderManager } from './manager.js';
import { OrderQueryService } from './query.service.js';
import { OrderService } from './service.js';
import { OrderValidatorService } from './validator.service.js';

@Module({
  imports: [CatalogModule],
  providers: [
    OrderManager,
    OrderService,
    OrderQueryService,
    OrderValidatorService,
    OrderAuthorizationService,
  ],
  exports: [OrderService, OrderQueryService, OrderAuthorizationService],
})
export class OrderModule {}
