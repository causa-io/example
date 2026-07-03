# Private npm package

How shared TypeScript utilities are published once as a private npm package and consumed by the services, and how Causa wires the registry authentication transparently.

## The reason

Several services need the same code: auth guards, small helpers, reusable business logic, etc.

## The solution

This code is published as a **versioned package**. A service depends on `@bookshop-example/common@^0.1.0` exactly as it depends on any third-party library. A breaking change to the shared code surfaces as a version bump the consumer opts into, not a silent edit reaching across folders.

The package is private — it must not land on the public npm registry — so it lives in a Google Artifact Registry npm repository, and every project that installs or publishes it has to authenticate. The interesting part is that Causa does this with a **short-lived GCP access token** rather than a stored npm token.

### A `package` project

The shared code is a Causa project of `type: package`. A package's artefact is an npm tarball, not a container: `cs build` runs `npm run build` then `npm pack`, and `cs publish` runs `npm publish`.

```yaml
project:
  name: common-npm-package
  language: typescript
  type: package
```

### One `.npmrc` routes the scope — for install and publish

The package name is **scoped**: `@bookshop-example/common`. A single `.npmrc`, carried identically by the package and by every consumer, maps that scope to the private registry and supplies the token:

```
@bookshop-example:registry=https://europe-west1-npm.pkg.dev/bookshop-example-common/npm/
//europe-west1-npm.pkg.dev/bookshop-example-common/npm/:_authToken=${NPM_TOKEN}
```

The Artifact Registry npm URL has the shape `https://<region>-npm.pkg.dev/<gcp-project>/<repo>/`. Here that is region `europe-west1`, the shared-infrastructure project `bookshop-example-common`, and a repo named `npm`. That repository is provisioned alongside the Docker one in the common infrastructure.

### `NPM_TOKEN` is a short-lived GCP access token, injected by Causa

The `${NPM_TOKEN}` in `.npmrc` is not a stored secret. It is a GCP access token minted from the caller's own credentials by the `google.accessToken` secret backend, and Causa injects it into the environment of every npm command it runs:

```yaml
# causa.typescript.yaml
secrets:
  gcpAccessToken:
    backend: google.accessToken

javascript:
  npm:
    environment:
      NPM_TOKEN:
        $format: ${ secret('gcpAccessToken') }
```

So a developer or CI runner authenticates to the registry with whatever GCP identity they already hold — nothing to rotate, nothing to leak.

### How a service (a container) gets the package at build time

A service is packaged as a container, so its `npm ci` runs inside `docker build`, where the environment injection above does not reach. The same token is therefore also exposed as a **Docker build secret**:

```yaml
# causa.typescript.yaml
serviceContainer:
  buildSecrets:
    NPM_TOKEN:
      value:
        $format: ${ secret('gcpAccessToken') }
```

The Dockerfile shipped by `@causa/workspace-typescript` copies the service's `.npmrc`, then mounts that secret for `npm ci` (`--mount=type=secret,id=NPM_TOKEN` — a BuildKit secret, so the token never lands in an image layer). npm expands `${NPM_TOKEN}` from it and authenticates against Artifact Registry.

### Consuming it

A service lists the package as an ordinary semver dependency — not a `file:` or `workspace:` link — and carries the identical `.npmrc`:

```json
"dependencies": {
  "@bookshop-example/common": "^0.1.0"
}
```

### Suggestion: supply-chain hardening

The same `.npmrc` is a natural place to add supply-chain safeguards. Consider layering in `min-release-age` (refuse releases newer than N days, blunting a compromised fresh publish) and `strict-allow-scripts` (only run the install scripts explicitly allowlisted in `package.json`). Both harden npm in general and are orthogonal to the private-registry mechanism, so they are left out of this example to keep it focused — but they are recommended in a real repository.

## In this repository

**The package project — `@bookshop-example/common`:**

- Project declaration —
  [causa.yaml](../domains/common/npm-package/causa.yaml) (`type: package`, `openApi: null`).
- Manifest —
  [package.json](../domains/common/npm-package/package.json) (scoped name, ESM, `main` /
  `types`, no `publishConfig`).
- Registry + auth —
  [.npmrc](../domains/common/npm-package/.npmrc).
- TypeScript build config —
  [tsconfig.json](../domains/common/npm-package/tsconfig.json).

**A consuming service — the catalog service:**

- Manifest depending on the package —
  [package.json](../domains/catalog/service/package.json)
  (`@bookshop-example/common: ^0.1.0`).
- The same registry + auth —
  [.npmrc](../domains/catalog/service/.npmrc).
- TypeScript build config —
  [tsconfig.json](../domains/catalog/service/tsconfig.json).

**The Causa wiring:**

- `NPM_TOKEN` from a GCP access token, injected for npm commands and as a Docker build secret
  — [causa.typescript.yaml](../causa.typescript.yaml).

**The registry itself:**

- The Artifact Registry npm repository —
  [infrastructure/common/npm-registry.tf](../infrastructure/common/npm-registry.tf).
