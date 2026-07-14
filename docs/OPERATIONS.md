# Operations

## Migrations and upgrades

Back up PostgreSQL and object storage, deploy the new image, run `pnpm db:migrate` exactly once, then verify `/api/health`. Migrations are forward-only. Roll back application code only when the release notes declare the schema backward compatible.

## Backup and restore

Take PostgreSQL base backups/PITR and versioned object-store snapshots on the same documented schedule. Record the database recovery timestamp and retain object versions spanning it. A quarterly restore drill must restore both into an isolated environment, run the artefact reconciliation command, and verify sampled manifest hashes.

## Key rotation

Publish the new public JWK before signing with its private key. Retain old public keys through the maximum receipt lifetime. Set a new key ID, deploy signers, and only then retire the prior private key. Emergency revocation is published through the JWKS/status endpoint; offline verifiers observe it on their next refresh.

## Health and privacy

`/api/health` is liveness; `/api/ready` checks database access without leaking configuration. Logs must not include credentials, action bodies, evidence, or push payload contents. Telemetry is optional in self-hosted deployments.
