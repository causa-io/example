// The `order` feature module: providers for the Ordering domain's own entity.

import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/module.js';
import { OrderAuthorizationService } from './authorization.service.js';
import { OrderManager } from './manager.js';
import { OrderQueryService } from './query.service.js';
import { ReviewReminderSchedulingService } from './review-reminder-scheduling.service.js';
import { ReviewReminderService } from './review-reminder.service.js';
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
    ReviewReminderService,
  ],
  exports: [
    OrderService,
    OrderQueryService,
    OrderAuthorizationService,
    ReviewReminderSchedulingService,
    ReviewReminderService,
  ],
})
export class OrderModule {}
