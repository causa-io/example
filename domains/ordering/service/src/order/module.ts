// The `order` feature module: providers for the Ordering domain's own entity.

import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/module.js';
import { OrderAuthorizationService } from './authorization.service.js';
import { OrderManager } from './manager.js';
import { OrderService } from './service.js';
import { OrderValidatorService } from './validator.service.js';

@Module({
  imports: [CatalogModule],
  providers: [
    OrderManager,
    OrderService,
    OrderValidatorService,
    OrderAuthorizationService,
  ],
  exports: [OrderService, OrderAuthorizationService],
})
export class OrderModule {}
