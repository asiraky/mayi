# May I?

[![CI](https://github.com/asiraky/mayi/actions/workflows/ci.yml/badge.svg)](https://github.com/asiraky/mayi/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[Website](https://mayi.sh) · [Documentation](https://mayi.sh/docs/) · [Source](https://github.com/asiraky/mayi)

> [!WARNING]
> May I? is pre-release security infrastructure. Review the threat model and run your own security assessment before production use.

May I? is an approval service for software agents.

Picture a release agent working through a deployment. It has built the image and checked the target, but production is the point where a person should take responsibility. The agent sends May I? the exact release digest, environment, and expected current version. A human reviews that frozen request in the web or mobile app. If they approve it, May I? returns a short-lived signed receipt bound to those details. Change the digest or the target and the receipt no longer matches.

The approval covers only the submitted action. It does not give the agent a general green light.

## Example

An agent can request an approval through the in-repository TypeScript client:

```ts
import { MayiClient } from "@mayi/sdk";

const mayi = new MayiClient({
  origin: "https://mayi.example.com",
  // Fetch a current OAuth token for every authenticated call. The SDK never stores it.
  getAccessToken: async () => hostOAuthSession.getAccessToken(),
});

const pending = await mayi.approvals.request({
  action: {
    kind: "tool-call",
    toolName: "deploy_release",
    callId: "call-42",
    input: { environment: "production", releaseDigest: "sha256:8c7f..." },
  },
  explanation: "Deploy the release that passed CI.",
  expiresInSeconds: 900,
  callback: { url: "https://agent.example.com/mayi/callback", state: sealedCallbackState },
}, { idempotencyKey: eveRequestId });
console.log(pending.id); // for example: aZbYcXdWeVfU
```

The `@mayi/sdk` workspace package is currently source-only and is not published to npm. The request returns a sealed `PENDING` approval immediately and does not hold the process open while a person decides. The caller supplies the idempotency key so retries keep the same identity. Access tokens, callback state, receipts, and sensitive action input must not be logged; the SDK does not retain OAuth access or refresh tokens.

After approval, the executor verifies the signed receipt and recomputes the action digest before doing any work. See [the API guide](docs/API.md) for the HTTP and MCP versions of the same flow.

## Run locally

Requirements: Node 22+, pnpm 10+, and Docker.

Set up once:

```sh
cp .env.example .env
docker compose up -d postgres
pnpm install
pnpm db:migrate
```

If Postgres fails to start because port 5432 is already taken by another project, set
`POSTGRES_PORT` in `.env` to a free port and change the port in `DATABASE_URL` to match.

Only the API needs that setup. The marketing site and docs never touch the database, and
the app only reaches it indirectly, through the API.

There are three front ends and one API, each with its own dev server. They are
independent — run only the ones you are working on, in separate terminals:

| Command | Serves | URL | Needs |
| --- | --- | --- | --- |
| `pnpm dev` | API (nitro) | http://localhost:3000 | Postgres |
| `pnpm dev:web` | The app (vite) | http://localhost:5173 | `pnpm dev` |
| `pnpm dev:site` | Marketing + docs (astro) | http://localhost:4321 | nothing |
| `pnpm dev:mobile` | Mobile (expo) | expo cli | `pnpm dev` |

The app proxies `/api` to port 3000, so it needs `pnpm dev` running alongside it;
signing in fails otherwise. The marketing site and docs are fully static and need
nothing else — `pnpm dev:site` on its own is enough to work on content or styling.
Its "Open app" links point at http://localhost:5173 in dev and at production in a
build; set `PUBLIC_APP_URL` in `apps/site/.env` to override (self-hosters serving the
app on their own domain set it at build time).

Note that `pnpm dev` alone also serves the app at http://localhost:3000, but from the
last `pnpm --filter @mayi/web build` rather than from source — no HMR, and stale until
you rebuild. Use port 5173 while working on the app; port 3000 is what production
looks like.

Create a signing key with `pnpm --filter @mayi/receipts generate-key` and copy the two
JSON values into `.env` before issuing production-like receipts.

If `pnpm db:migrate` fails with `type "approval_state" already exists`, the Docker volume
holds a schema from before the migrations were last renumbered. Migrations replay from
`0000` against a database that already has those objects. There is no in-place upgrade;
recreate the volume, which **destroys the local database**:

```sh
docker compose down && docker volume rm mayi_postgres-data
docker compose up -d postgres && pnpm db:migrate
```

The landing page and Markdown documentation live in `apps/site`; editing the files
under `apps/site/src/content` updates the published content on the next deployment.

The first normal sign-up creates a personal workspace. Self-hosters may instead set `BOOTSTRAP_SECRET`; while it is set, the first sign-up must send it as `bootstrapSecret`, and the database consumes it atomically.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
```

Architecture, security boundaries, deployment, backup, and operational procedures are in [`docs/`](docs/). Start with the [threat model](docs/THREAT_MODEL.md) if you plan to put May I? in front of a real system.

## Community

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

Licensed under the [Apache License 2.0](LICENSE).
