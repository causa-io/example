// The `order` feature module: providers for the Ordering domain's own entity.

import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/module.js';
import { OrderAuthorizationService } from './authorization.service.js';
import { OrderManager } from './manager.js';
import { OrderQueryService } from './query.service.js';
import { ReviewReminderSchedulingService } from './review-reminder-scheduling.service.js';
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
    ReviewReminderSchedulingService,
  ],
  exports: [
    OrderService,
    OrderQueryService,
    OrderAuthorizationService,
    ReviewReminderSchedulingService,
  ],
})
export class OrderModule {}
