# Deployment

## Shared requirements

Provide PostgreSQL 15+, an immutable private object store, `PUBLIC_ORIGIN`, persistent Ed25519 receipt JWKs, `CRON_SECRET`, and provider credentials. Apply migrations before serving new code. Production must use HTTPS and secure cookies. Configure `CONSUMER_API_KEYS` as a JSON map from receipt audience to relying-party secret when consumed receipts are enabled.

## Cloudflare

The public site and application are separate Workers:

- `mayi-site` serves the static Astro landing page and Markdown documentation at `mayi.sh`. Build it with `pnpm --filter @mayi/site build` and deploy with `pnpm deploy:site`.
- `may-i` serves the authenticated application and API at `app.mayi.sh`.

This layout can run within free allowances while usage is modest. Static asset requests are free and unlimited. The application is still subject to the Workers, Hyperdrive, R2, and PostgreSQL provider limits. A Neon Free database is a practical default. Use its direct connection string as the Hyperdrive origin because Hyperdrive supplies the connection pool.

For the application Worker, first activate R2 for the Cloudflare account. Create a private bucket named `may-i-artefacts`, then create a Hyperdrive configuration named `may-i` with query caching disabled and a PostgreSQL connection string. Replace the Hyperdrive ID in `wrangler.toml`, set secrets with `wrangler secret put`, run `pnpm --filter @mayi/server build:cloudflare`, and deploy. The first successful deployment provisions the `app.mayi.sh` custom domain. The Worker wrapper handles the configured minute Cron Trigger and invokes durable-job recovery with `CRON_SECRET`.

At minimum, set `PUBLIC_ORIGIN=https://app.mayi.sh`, `RECEIPT_ISSUER=https://app.mayi.sh`, persistent `RECEIPT_PRIVATE_JWK` and `RECEIPT_PUBLIC_JWK` values, and a random `CRON_SECRET`. Generate the JWK pair with `pnpm --filter @mayi/receipts generate-key`. Store production values as Worker secrets or variables; do not commit them.

Pushes to `main` deploy only after CI passes. Configure the GitHub `production` environment with secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `NEON_DATABASE_URL`, plus the `CLOUDFLARE_HYPERDRIVE_ID` environment variable. `NEON_DATABASE_URL` is the direct, non-pooled Neon connection string and is used only by the deployment runner. Every application deployment applies committed Drizzle migrations before deploying the Worker; a failed migration stops the deployment. The same pipeline can be started manually with **Actions → CI → Run workflow**.

Set repository variable `CLOUDFLARE_SITE_DEPLOY_ENABLED` to `true` for the public site and `CLOUDFLARE_DEPLOY_ENABLED` to `true` for the application. Protect the production environment with reviewers if the repository has more than one trusted maintainer.

## Vercel

Set the same PostgreSQL and S3-compatible environment variables, then deploy from the repository root. `vercel.json` builds the Nitro Vercel output and invokes the durable-job recovery endpoint every minute. Set the cron authorization integration to the same runner secret.

## VPS

Generate receipt keys, set the `.env` values, then run `docker compose --profile full up -d`. For TLS, set `MAYI_DOMAIN` and enable the `tls` profile. Existing PostgreSQL/S3 services can replace the Compose volumes. No telemetry or Cloudflare service is required.

## Native releases

Replace the EAS project ID and application identifiers in `apps/mobile/app.json`, configure APNs/FCM in EAS, then use the development profile for device notification tests. Production submission requires the operator's Apple and Google accounts; those credentials are intentionally not committed.
