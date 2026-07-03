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
