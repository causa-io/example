// The public HTTP API container root.

import { Module } from '@nestjs/common';
import { BaseModule } from './base.module.js';

@Module({
  imports: [BaseModule],
})
export class ApiModule {}
