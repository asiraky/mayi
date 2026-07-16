---
title: "Getting started"
description: "Run May I? locally and create the first workspace."
order: 2
---

## Requirements

- Node.js 22 or newer
- pnpm 10 or newer
- Docker

## Start the service

```sh
cp .env.example .env
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm dev
```

Run the browser client in another terminal:

```sh
pnpm dev:web
```

The first normal sign-up creates a personal workspace. Self-hosted installations can set `BOOTSTRAP_SECRET` to protect creation of the first owner.

From there an agent can start asking: `POST /api/approvals/request` for approve/deny with a signed receipt, or `POST /api/inputs` for a select or freeform question. Both resolve as signed events and both work through the `@mayiapp/sdk` client.

## Before production

Generate receipt signing keys, use separate database credentials for migrations and runtime access, configure private artefact storage, and read the repository's threat model.
