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

## Before production

Generate receipt signing keys, use separate database credentials for migrations and runtime access, configure private artefact storage, and read the repository's threat model.
