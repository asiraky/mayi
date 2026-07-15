# Deployment

## Shared requirements

All production targets require PostgreSQL 15+, a private durable object store, HTTPS, and the following runtime configuration:

- `PUBLIC_ORIGIN`, with `SESSION_COOKIE_SECURE=true` when it uses HTTPS;
- persistent `RECEIPT_PRIVATE_JWK` and `RECEIPT_PUBLIC_JWK` values generated with `pnpm --filter @mayi/receipts generate-key`, plus `RECEIPT_PREVIOUS_PUBLIC_JWKS` during key rotation;
- a random `CRON_SECRET` of at least 16 characters; and
- the credentials for each enabled provider.

Set `CONSUMER_API_KEYS` to a JSON object mapping receipt audiences to relying-party secrets only when consumed receipts are enabled. The optional push, email, and first-owner settings are documented in `.env.example`.

Dynamic OAuth registration records an atomic, database-backed attempt window
before body parsing and callback DNS resolution, plus a separate successful
registration limit. Its client identity must come from a trusted transport:

- Direct Node uses the socket peer and ignores `X-Forwarded-For`.
- Vercel uses its overwritten `X-Vercel-Forwarded-For` header when `VERCEL=1`.
- The committed Cloudflare Worker sets
  `OAUTH_REGISTRATION_TRUSTED_IP_HEADER=cf-connecting-ip`; do not put an
  attacker-controlled Worker in front of it without replacing that trust
  boundary.
- A VPS reverse proxy may set `OAUTH_REGISTRATION_TRUSTED_IP_HEADER` only when
  it overwrites that header with exactly one client address and the application
  port cannot be reached around the proxy. Multi-hop/comma-separated values are
  rejected instead of guessing which hop is trusted.

The attempt limit is shared across runtime instances. Production deployments
should also enforce a coarse abuse limit at their trusted edge to reject floods
before they consume a database connection. Cloudflare documents the
[`CF-Connecting-IP` contract](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip),
and Vercel documents its
[`X-Vercel-Forwarded-For` header](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for).

Back up the database and object store, then apply the committed Drizzle migrations before new application code serves production traffic. After deployment, verify `/api/health` and `/api/ready`. Receipt keys and `CRON_SECRET` must persist across deployments; rotating them is a separate operation described in `docs/OPERATIONS.md`.

The npm Trusted Publishing, protected environment, version-PR, prerelease, and
immutable rollback procedures for `@mayi/sdk` and `@mayi/eve` are documented in
[`docs/RELEASING.md`](RELEASING.md).

## Cloudflare

The public site and application are separate Workers:

- `mayi-site` serves the Astro landing page and Markdown documentation at `mayi.sh`. `pnpm deploy:site` builds and deploys it with `apps/site/wrangler.jsonc`.
- `may-i` serves the authenticated application and API at `app.mayi.sh` using `wrangler.toml`.

Static asset requests are free and unlimited, but the application remains subject to the current Workers, Hyperdrive, R2, and PostgreSQL-provider limits. Check the [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/), and [R2 pricing](https://developers.cloudflare.com/r2/pricing/) before relying on a free allowance. A small Neon database is a practical starting point. Hyperdrive provides connection pooling, so use the direct, non-pooled Neon connection string as its origin.

For the application Worker:

1. Create the private bucket with `pnpm exec wrangler r2 bucket create may-i-artefacts`.
2. Create a cache-disabled Hyperdrive configuration with `pnpm exec wrangler hyperdrive create may-i --connection-string="$DATABASE_URL" --caching-disabled`.
3. Replace `REPLACE_WITH_HYPERDRIVE_ID` in `wrangler.toml` with the returned ID. Query caching must remain disabled because authorization reads require read-after-write consistency.
4. Apply migrations with the direct PostgreSQL URL: `DATABASE_URL="$DATABASE_URL" pnpm db:migrate`.
5. Store `RECEIPT_PRIVATE_JWK`, `RECEIPT_PUBLIC_JWK`, `RECEIPT_PREVIOUS_PUBLIC_JWKS`, and `CRON_SECRET` with `pnpm exec wrangler secret put NAME --config wrangler.toml`. Store optional provider credentials the same way.
6. Run `pnpm --filter @mayi/server build:cloudflare`, then `pnpm exec wrangler deploy --config wrangler.toml`.

The first successful deployment provisions the `app.mayi.sh` custom domain. The Worker Cron Trigger runs every minute and calls the authenticated durable-job recovery endpoint.

Forwarding webhook verification and delivery require a runtime that can connect
to the address selected by public-DNS validation while retaining the original
TLS hostname. The Node and Vercel paths support this. Cloudflare and other edge
runtimes fail forwarding closed unless the deployment supplies an equivalent
public-only, address-pinned egress path; approval callbacks continue to use
their separately documented transport policy.

### GitHub deployment

Relevant pushes to `main` deploy only after the `verify` job passes. Configure GitHub's protected `production` environment with these secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `NEON_DATABASE_URL` (the direct, non-pooled URL used by the deployment runner)
- `RECEIPT_PRIVATE_JWK`
- `RECEIPT_PUBLIC_JWK`
- `RECEIPT_PREVIOUS_PUBLIC_JWKS` (set it to `[]` outside a rotation window)
- `CRON_SECRET`

Add `CLOUDFLARE_HYPERDRIVE_ID` as an environment variable, not a secret. The workflow synchronizes the Hyperdrive origin with query caching disabled, applies migrations, substitutes the binding ID, and deploys the Worker and its secrets. A failure before the deploy step leaves the previous Worker running. Secrets previously added directly to the Worker, such as optional provider credentials, are preserved when the workflow deploys its secrets file.

Set repository variable `CLOUDFLARE_SITE_DEPLOY_ENABLED=true` to enable public-site deployments and `CLOUDFLARE_DEPLOY_ENABLED=true` to enable application deployments. The same pipeline can be started with **Actions -> CI -> Run workflow**; a manual run attempts both deployments when their enable variables are set. Protect the `production` environment with reviewers when more than one maintainer can deploy.

## Vercel

Create a Vercel project from the repository root and keep the Framework Preset set to **Other**. The committed `vercel.json` builds Nitro's Build Output API output and registers `/api/internal/jobs/drain` every minute. Set the shared runtime values plus `DATABASE_URL`, `OBJECT_STORE=s3`, and all `S3_*` values from `.env.example` in the Vercel project. Set `CRON_SECRET`; Vercel automatically sends it as `Authorization: Bearer <CRON_SECRET>` to the job endpoint.

The every-minute schedule requires a paid Vercel plan: Hobby cron jobs can run only once per day. If daily recovery is acceptable, change the committed schedule before deploying on Hobby. See [Vercel's cron limits](https://vercel.com/docs/cron-jobs/manage-cron-jobs#cron-jobs-accuracy).

Vercel does not apply database migrations. A production release pipeline must build and stage the deployment, back up and migrate PostgreSQL from a trusted runner, and only then promote the new deployment. Do not enable an automatic production deployment that can serve new code before its migration succeeds.

## VPS

Copy `.env.example` to `.env`, generate the receipt keys, and set at least `PUBLIC_ORIGIN`, `SESSION_COOKIE_SECURE`, both receipt JWKs, `RECEIPT_PREVIOUS_PUBLIC_JWKS`, and `CRON_SECRET`. For TLS, also set `MAYI_DOMAIN` to the public hostname. The Compose PostgreSQL and application ports bind to loopback; Caddy is the public entry point when TLS is enabled.

Start PostgreSQL and apply migrations before starting the application:

```sh
docker compose up -d postgres
pnpm install --frozen-lockfile
DATABASE_URL=postgres://mayi:mayi@localhost:5432/mayi pnpm db:migrate
docker compose --profile full up -d
```

For Caddy-managed TLS, use both profiles:

```sh
docker compose --profile full --profile tls up -d
```

Configure the host scheduler to send an authenticated `POST` to `/api/internal/jobs/drain` once per minute with `Authorization: Bearer <CRON_SECRET>`. Without this scheduler, pending notifications, forwarding retries, terminal callback delivery, stale-lease recovery, and approval expiry recovery do not run. Keep the bearer value in a root-readable environment or credential file rather than embedding it in a world-readable crontab.

An external PostgreSQL service can replace the bundled service after updating the application's `DATABASE_URL` and Compose dependency. For S3-compatible storage, set `OBJECT_STORE=s3` and the `S3_*` values; the mounted `OBJECT_DIRECTORY` is then ignored. No telemetry or Cloudflare service is required.

## Native releases

Replace the EAS project ID, iOS bundle identifier, Android package, and placeholder associated-link domains in `apps/mobile/app.json`. Configure APNs and FCM credentials in EAS. The development profile is intended for device-notification tests.

Production builds are triggered by a `v*` Git tag only when repository variable `EAS_RELEASE_ENABLED=true`. Store the EAS automation token as the GitHub `EXPO_TOKEN` secret; this is distinct from the server's optional `EXPO_ACCESS_TOKEN` used to send push notifications. Submission still requires the operator's Apple and Google accounts, which are intentionally not committed.
