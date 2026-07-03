// The liveness/readiness endpoint every Causa service exposes.
//
// `HealthCheckModule.forIndicators([...])` from `@causa/runtime/nestjs` wires a
// `GET /health` route that returns 200 only when every listed indicator passes.
// The indicators below check the backing services this container actually talks
// to, so a service that cannot reach Spanner or Pub/Sub is reported unhealthy
// (and Cloud Run stops sending it traffic).

import {
  PubSubHealthIndicator,
  SpannerHealthIndicator,
} from '@causa/runtime-google';
import { HealthCheckModule } from '@causa/runtime/nestjs';

/**
 * The health check module, shared by both container roots (API and event
 * handler) through {@link BaseModule}.
 */
export const HealthModule = HealthCheckModule.forIndicators([
  SpannerHealthIndicator,
  PubSubHealthIndicator,
]);
