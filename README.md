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

An agent can create a draft through the in-repository TypeScript client, attach evidence if needed, then seal it for review:

```ts
import { MayIClient } from "@mayi/sdk";

const mayi = new MayIClient("https://mayi.example.com", process.env.MAYI_AGENT_TOKEN);

const draft = await mayi.createApproval({
  action: {
    kind: "deploy.release",
    version: "1",
    audience: "production-deployer",
    parameters: {
      environment: "production",
      releaseDigest: "sha256:8c7f...",
      expectedCurrentRelease: "sha256:12ab...",
    },
  },
  explanation: "Deploy the release that passed CI.",
  enforcement: "verified",
  expiresInSeconds: 900,
});

const pending = await mayi.sealApproval(draft.id, []);
console.log(pending.id); // for example: aZbYcXdWeVfU
```

The `@mayi/sdk` workspace package is currently source-only and is not published to npm. Both `await` expressions above cover short HTTP requests: sealing returns a `PENDING` approval immediately and does not hold the process open while a person decides. The caller must persist the approval ID and end its current invocation, then read the approval after its own scheduler resumes it. May I? currently supports polling for that read, but does not yet send a decision webhook back to the originating agent.

After approval, the executor verifies the signed receipt and recomputes the action digest before doing any work. See [the API guide](docs/API.md) for the HTTP and MCP versions of the same flow.

## Run locally

Requirements: Node 22+, pnpm 10+, and Docker.

```sh
cp .env.example .env
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm dev
```

Run the browser client with `pnpm dev:web`, or use the server's API directly. Create a signing key with `pnpm --filter @mayi/receipts generate-key` and copy the two JSON values into `.env` before issuing production-like receipts.

The public landing page and Markdown documentation live in `apps/site`. Run them with `pnpm dev:site`; editing the files under `apps/site/src/content` updates the published content on the next deployment.

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
