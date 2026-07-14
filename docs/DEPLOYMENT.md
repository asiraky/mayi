# Deployment

## Shared requirements

Provide PostgreSQL 15+, an immutable private object store, `PUBLIC_ORIGIN`, persistent Ed25519 receipt JWKs, `CRON_SECRET`, and provider credentials. Apply migrations before serving new code. Production must use HTTPS and secure cookies. Configure `CONSUMER_API_KEYS` as a JSON map from receipt audience to relying-party secret when consumed receipts are enabled.

## Cloudflare

Create a Hyperdrive binding named `HYPERDRIVE` with query caching disabled and a private R2 bucket binding named `ARTEFACTS`. Replace the IDs in `wrangler.toml`, set secrets with `wrangler secret put`, run `pnpm --filter @mayi/server build:cloudflare`, and deploy. The Worker wrapper handles the configured minute Cron Trigger and invokes durable-job recovery with `CRON_SECRET`.

Pushes to `main` deploy only after CI passes. Configure the GitHub `production` environment with secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, plus the `CLOUDFLARE_HYPERDRIVE_ID` environment variable. Protect that environment with reviewers if the repository has more than one trusted maintainer.

## Vercel

Set the same PostgreSQL and S3-compatible environment variables, then deploy from the repository root. `vercel.json` builds the Nitro Vercel output and invokes the durable-job recovery endpoint every minute. Set the cron authorization integration to the same runner secret.

## VPS

Generate receipt keys, set the `.env` values, then run `docker compose --profile full up -d`. For TLS, set `MAYI_DOMAIN` and enable the `tls` profile. Existing PostgreSQL/S3 services can replace the Compose volumes. No telemetry or Cloudflare service is required.

## Native releases

Replace the EAS project ID and application identifiers in `apps/mobile/app.json`, configure APNs/FCM in EAS, then use the development profile for device notification tests. Production submission requires the operator's Apple and Google accounts; those credentials are intentionally not committed.
