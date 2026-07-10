// The service entrypoint.
//
// ONE container image, TWO roots. Cloud Run deploys this image twice from the
// same configuration (see domains/ordering/infrastructure/service.tf):
//   - The public API service (default) → boots `ApiModule`.
//   - The internal event-handler service (`EVENT_HANDLER=true`) → boots
//     `EventsModule`, which serves the triggers.
//
// Selecting the root at runtime keeps a single build/release artifact with the
// entire business logic for this domain, while letting the two services scale
// — and be exposed — independently.

import { updatePinoConfiguration } from '@causa/runtime';
import { googlePinoConfiguration } from '@causa/runtime-google';
import { createApp } from '@causa/runtime/nestjs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiModule } from './api.module.js';
import { EventsModule } from './events.module.js';

// Emit structured logs in the format Google Cloud Logging understands: map Pino
// levels to Cloud Logging `severity`, tag errors for Error Reporting, and
// redact sensitive headers.
// Applied process-wide, before the app (and its logger) boot.
updatePinoConfiguration(googlePinoConfiguration);

const PORT = process.env.PORT ?? 8080;
const EVENT_HANDLER = !!process.env.EVENT_HANDLER;
// Accept larger event payloads.
const EVENT_BODY_LIMIT = '5mb';
// Expects the environment to set the domain(s) allowed to call the public API.
// In development, it is usually easier to allow all origins for local testing
// of the frontend.
const CORS_ALLOWED_ORIGINS = new RegExp(
  process.env.CORS_ALLOWED_ORIGINS ?? '.*',
);

async function bootstrap(): Promise<void> {
  const app = EVENT_HANDLER
    ? await createApp(EventsModule, {
        extraConfiguration: (app: NestExpressApplication) =>
          app.useBodyParser('json', { limit: EVENT_BODY_LIMIT }),
      })
    : await createApp(ApiModule, {
        nestApplicationOptions: {
          cors: { origin: CORS_ALLOWED_ORIGINS },
        },
      });

  await app.listen(PORT);
}

void bootstrap();
