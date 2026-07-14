# Contributing

Use Node 22 and pnpm 10. Before submitting a change, run `pnpm typecheck`, `pnpm test`, and the deployment builds relevant to the change. Schema changes require a checked-in Drizzle migration and tenant-isolation coverage. Security-sensitive changes must describe their trust boundary, failure mode, and concurrency behavior.

Do not weaken exact-action binding, database-time expiry, current-eligibility checks, idempotency fingerprints, private evidence handling, or receipt audience binding to improve convenience.
