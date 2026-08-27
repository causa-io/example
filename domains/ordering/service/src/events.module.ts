// The event-handler container root.
//
// Booted when `EVENT_HANDLER=true` (the internal Cloud Run service — see
// domains/ordering/infrastructure/service.tf). It gathers every module that
// registers trigger handlers.

import { JsonObjectSerializer } from '@causa/runtime';
import {
  CloudTasksEventHandlerInterceptor,
  PubSubEventHandlerInterceptor,
} from '@causa/runtime-google';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BaseModule } from './base.module.js';
import { CatalogEventModule } from './catalog/event.module.js';
import { OrderEventModule } from './order/event.module.js';

@Module({
  imports: [BaseModule, CatalogEventModule, OrderEventModule],
  providers: [
    {
      // The interceptor that turns an incoming Pub/Sub push into the typed
      // event injected by `@EventBody()`: it validates the push envelope,
      // base64-decodes the data, deserializes it (JSON here) against the
      // handler's event type, and validates it.
      // `isDefault: false` means it only runs on routes that opt in via
      // `@UseEventHandler('google.pubSub')` — which the generated
      // events-controller decorators do.
      provide: APP_INTERCEPTOR,
      useClass: PubSubEventHandlerInterceptor.withSerializer(
        new JsonObjectSerializer(),
        { isDefault: false },
      ),
    },
    {
      // The interceptor for Cloud Tasks push deliveries. It parses the task
      // headers and validates the JSON body against the handler's
      // `@EventBody()` type. Like the Pub/Sub one, `isDefault:
      // false` means it runs only on routes that opt in via
      // `@UseEventHandler('google.cloudTasks')` — which the generated
      // events-controller decorator applies to Cloud Tasks triggers. No
      // serializer: the body is already JSON (no Pub/Sub push envelope to
      // decode).
      provide: APP_INTERCEPTOR,
      useClass: CloudTasksEventHandlerInterceptor.withOptions({
        isDefault: false,
      }),
    },
  ],
})
export class EventsModule {}
