# Patterns & guidelines

The patterns this example repository demonstrates, each with a dedicated page.

**Maturity** — how confidently the pattern should be reused elsewhere:

- 🪨 **Stable** — battle-tested in production Causa codebases; adopt freely.
- 💡 **Recommended** — good default, but weigh it against your context.
- 🧪 **Experimental** — still being evaluated; expect it to change.

**Tags** — the area a pattern touches (a pattern may carry several):

- 🧱 **Infrastructure** — Terraform, cloud resources, deployment.
- 🏷️ **Architecture** — modelling, API contracts, domain / system-wide design.
- 📘 **TypeScript** — architecture and implementation at the service-container level.
- 🔨 **Tooling** — repository setup, packaging, CI.

## Patterns

| Pattern | Tags | Maturity | Description |
| --- | --- | --- | --- |
| [Open / closed enum](patterns/open-closed-enum.md) | 🏷️ Architecture | 🪨 Stable | How to model an enumerated value in a Causa schema, and why a write DTO should use a closed enum even when the stored property is open. |
| [Private npm package](patterns/private-npm-package.md) | 🔨 Tooling | 🪨 Stable | Share code across services: publish it as a versioned, private npm package on Artifact Registry. |
| [Simple projection](patterns/simple-projection.md) | 📘 TypeScript · 🏷️ Architecture | 🪨 Stable | Maintain a local view of another domain's entity, built from that domain's unordered at least once event stream. |
| [Service infrastructure](patterns/service-infrastructure.md) | 🧱 Infrastructure | 🪨 Stable | Deploying a service and the surrounding infrastructure: the Cloud Run public-API + internal event-handler split, wired to the backend's Pub/Sub topics, Spanner databases, and shared API router. |
| [Environment infrastructure](patterns/environment-infrastructure.md) | 🧱 Infrastructure | 🪨 Stable | Set up the initial infrastructure for an environment: the per-environment backend project wiring Causa-published modules into Pub/Sub topics, Spanner databases, Firestore, and a public API router — including DNS, TLS, and Firebase service-account impersonation. |
| [Controller / Service / Manager split](patterns/service-layering.md) | 📘 TypeScript · 🏷️ Architecture | 🪨 Stable | How to layer Controller (HTTP) → Service (commands) → Manager (`VersionedEntityManager` writes + events), and where authorization — including the manager's `validationFn` hook — fits. |
| [Authorization service](patterns/authorization-service.md) | 📘 TypeScript | 🪨 Stable | Centralize authorization decisions in one injectable reused by controllers and state-change validation. |
| [Validator service](patterns/validator-service.md) | 📘 TypeScript | 🪨 Stable | Split command data sanitization and validation logic into its own service. |
| [Pagination](patterns/pagination.md) | 📘 TypeScript | 💡 Recommended | Implement a list endpoint: keyset (token) pagination in a `QueryService`, using the runtime `PageQuery` / `Page` / opaque cursor. |
| [Array indexing via custom projection](patterns/array-indexing-via-custom-projection.md) | 🏷️ Architecture | 🪨 Stable | Filter or list by a value inside an array column: materialize a companion interleaved table and index that. |
| [Service error / error DTO split](patterns/service-error-dto-split.md) | 📘 TypeScript · 🏷️ Architecture | 🪨 Stable | Service classes throw plain typed `Error`s, which are then mapped to a public error DTO (`statusCode` + `errorCode` + `message`, plus data) at the controller with `@TryMap` / `toDto`. |
| [Testing with `AppFixture` + Google fixtures](patterns/testing-with-app-fixture.md) | 📘 TypeScript · 🔨 Tooling | 🪨 Stable | Write tests that boot the real NestJS module against emulators, focusing on contract-level tests (controllers), asserting with the generated `make` / `expect` helpers. |
