# 🧑‍🏫 Causa example — Bookshop

A small, heavily commented backend that demonstrates good practice when building with the [Causa](https://github.com/causa-io) framework. It is a teaching example: the point is not the business logic (a tiny online bookshop) but the patterns: event-driven and architecture principles, infrastructure, coding (TypeScript) guidelines around the Causa runtime, etc.

**What is Causa?** A convention-driven framework and CLI (`cs`) for event-driven backends. A workspace is a monorepo of projects, each configured through `causa.*.yaml` files that merge from the root down. Causa reads that configuration plus a shared data model (entities, events, DTOs, and storage schemas written as JSON Schema) to generate code, wire cloud infrastructure, and drive the build / test / deploy lifecycle. Its capabilities are extended by [workspace modules](https://github.com/orgs/causa-io/repositories?q=workspace-module-) (npm packages) for a given technology stack.

**Stack demonstrated here.** TypeScript [NestJS](https://nestjs.com) service containers on [Cloud Run](https://cloud.google.com/run), [Cloud Spanner](https://cloud.google.com/spanner) and [Firestore](https://cloud.google.com/firestore) for storage, [Pub/Sub](https://cloud.google.com/pubsub) for events, and [Terraform](https://www.terraform.io) for infrastructure — all on Google Cloud.

## 🚦 Where to start

- Install the [Causa CLI](https://github.com/causa-io/cli) so that you can run Causa commands against this project or yours.
- Browse the [patterns](patterns.md) to see what this repository demonstrates. Each pattern has a dedicated page under [`patterns/`](patterns/).
- Look at other [Causa repositories](https://github.com/orgs/causa-io/repositories) to check what technology stacks are supported.

## Repository layout

- 🌐 [domains/](./domains/): The code and infrastructure for each domain.
- 🧱 [infrastructure/](./infrastructure/): The base infrastructure for the each backend environment, and the infrastructure for the `common` project, which stores build artefacts for instance.
- 📝 [patterns/](./patterns/): The patterns this repository demonstrates, each with a dedicated page.

## ⚠️ A few things to keep in mind

- The business model is incomplete. The point is to define just enough to demonstrate the patterns.
- Even within the defined model, the implementation is not complete. The [ordering service](domains/ordering/service) is guaranteed to build and pass tests. The [catalog domain](domains/catalog) is modelled but not implemented.
- Only the architecture documented within a pattern should be used as reference. Some parts of the modelling may only serve a specific demonstration purpose and should not be considered as a guideline for architecture (for example, they may disregard eventual consistency constraints, expose an inconvenient API, etc).
- Most comments are written to explain the patterns and the reasoning. When applying the patterns to your own codebase, you may not need to repeat the same comments. Focus on your own business logic and non-obvious technical aspects.
