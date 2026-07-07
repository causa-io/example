// The public HTTP API container root.
//
// Imports the shared infrastructure (`BaseModule`), turns on authentication for
// every route (`AuthModule` + the Identity Platform bearer strategy), and pulls
// in every feature module that exposes HTTP endpoints. Each `*ApiModule`
// registers one entity's controller, so the routes served here are exactly the
// public API surface.
//
// `AuthModule` installs a global guard that requires a valid bearer token,
// rejecting anonymous callers with `401`, and populates `request.user`.
// Controllers read this with `@AuthUser()`.
// The guard needs a Passport strategy to validate the token:
// `IdentityPlatformStrategy`, which expects a Firebase Auth / Identity Platform
// token.
// Only the public API root gets this. The event-handler root (`EventsModule`)
// does not import the `AuthModule`.

import { IdentityPlatformStrategy } from '@causa/runtime-google';
import { AuthModule } from '@causa/runtime/nestjs';
import { Module } from '@nestjs/common';
import { BaseModule } from './base.module.js';
import { OrderApiModule } from './order/api.module.js';

@Module({
  imports: [BaseModule, AuthModule, OrderApiModule],
  providers: [IdentityPlatformStrategy],
})
export class ApiModule {}
