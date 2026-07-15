# Operations

## Migrations and upgrades

Back up PostgreSQL and object storage, deploy the new image, run `pnpm db:migrate` exactly once, then verify `/api/health`. Migrations are forward-only. Roll back application code only when the release notes declare the schema backward compatible.

## Backup and restore

Take PostgreSQL base backups/PITR and versioned object-store snapshots on the same documented schedule. Record the database recovery timestamp and retain object versions spanning it. A quarterly restore drill must restore both into an isolated environment, run the artefact reconciliation command, and verify sampled manifest hashes.

## Key rotation

Generate a new pair with `pnpm --filter @mayi/receipts generate-key`. First append the new public JWK to the `RECEIPT_PREVIOUS_PUBLIC_JWKS` JSON array without changing the active pair, deploy, and allow at least one verifier cache window for `/.well-known/jwks.json` to propagate. Then replace `RECEIPT_PRIVATE_JWK` and `RECEIPT_PUBLIC_JWK` with the new pair, replace the staged new key in the array with the old public key, and deploy again. The endpoint publishes the active key first and supports at most 15 additional keys; every key must be a public Ed25519 JWK with a unique `kid` matching `^[A-Za-z0-9._-]{1,128}$`.

Retain old public keys through the maximum receipt lifetime, then remove them from `RECEIPT_PREVIOUS_PUBLIC_JWKS`. Never put private JWKs in that variable. Emergency revocation removes the affected public key; offline verifiers observe the change on their next JWKS refresh.

The same active key signs terminal callback events. Retain an old public key for
at least the callback replay/event-age window as well as the receipt lifetime.
The body sent over HTTP is canonical JSON and must not be reserialized between
signature creation and transmission.

## Callback delivery recovery

The authenticated job drain retries callback network errors, timeouts, HTTP
408, 425, 429, and 5xx. Redirects and every other 4xx are permanent failures.
Every attempt re-resolves the exact stored HTTPS URL and rejects the destination
if any answer is non-public. Node deployments connect to the selected validated
address while retaining the original Host header and TLS SNI. Edge deployments
where connection pinning is unavailable revalidate immediately before a
`redirect: error` fetch; operators that require address pinning should use the
Node deployment.

Retries use `5 * 2^(attempt-1)` seconds with 50%-150% jitter and stop after 10
total attempts. The maximum delay from the first failed attempt until attempt 10
is 3,832.5 seconds (63 minutes 52.5 seconds), excluding request runtime and the
job scheduler interval. Connect, response, and total time are bounded to 3, 5,
and 10 seconds respectively; response bodies are discarded after at most 64
KiB. A worker lease is five minutes. Each drain reclaims stale `RUNNING` jobs so
a process crash cannot orphan delivery indefinitely.

Exhausted or permanently failed callbacks enter `DEAD_LETTER`. After correcting
the receiver, replay one with the same stable event ID and occurrence time:

```sh
curl -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$PUBLIC_ORIGIN/api/internal/callbacks/AbCdEfGhIjKl/replay"
```

Replay is allowed only from `DEAD_LETTER` and starts a new 10-attempt cycle.
Stored `last_error` values are bounded classifications such as `http_503` or
`network_error`; URLs, provider response bodies, opaque state, receipts, and
credentials must never be copied into errors, audit metadata, or logs.

## Health and privacy

`/api/health` is liveness; `/api/ready` checks database access without leaking configuration. Logs must not include credentials, action bodies, evidence, push payload contents, callback state, or receipts. Telemetry is optional in self-hosted deployments.
