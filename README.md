# May I?

[![CI](https://github.com/asiraky/mayi/actions/workflows/ci.yml/badge.svg)](https://github.com/asiraky/mayi/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> [!WARNING]
> May I? is pre-release security infrastructure. Review the threat model and run your own security assessment before production use.

May I? is a secure approval service for software agents. This repository is a pnpm TypeScript monorepo containing a Nitro service, React web client, Expo app, MCP/HTTP interfaces, PostgreSQL control plane, private artefact storage, and exact-action signed receipts.

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

The first normal sign-up creates a personal workspace. Self-hosters may instead set `BOOTSTRAP_SECRET`; while it is set, the first sign-up must send it as `bootstrapSecret`, and the database consumes it atomically.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
```

Architecture, security boundaries, deployment, backup, and operational procedures are in [`docs/`](docs/).

## Community

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

Licensed under the [Apache License 2.0](LICENSE).
