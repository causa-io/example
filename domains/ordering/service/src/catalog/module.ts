// The `catalog` feature module: everything in the ordering service that deals
// with catalogue data.
//
// The providers /services are exposed here, separate from the controller in
// event.module.ts

import { Module } from '@nestjs/common';
import { BookProjectionService } from './book-projection.service.js';

@Module({
  providers: [BookProjectionService],
  exports: [BookProjectionService],
})
export class CatalogModule {}
