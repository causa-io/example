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
