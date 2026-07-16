# Contributing

Use Node 22 and pnpm 10. Before submitting a change, run `pnpm typecheck`, `pnpm test`, and the deployment builds relevant to the change. Schema changes require a checked-in Drizzle migration and tenant-isolation coverage. Security-sensitive changes must describe their trust boundary, failure mode, and concurrency behavior.

Every pull request records release intent. Run `pnpm changeset` and select
`@mayiapp/sdk` and/or `@mayiapp/eve` for a publishable change. For internal-only,
test-only, or documentation-only work, run `pnpm changeset --empty` and commit
the generated empty changeset as the explicit no-release path. Do not edit
package versions or changelogs by hand and do not publish from a workstation.
The complete maintainer workflow is in [the release guide](docs/RELEASING.md).

Do not weaken exact-action binding, database-time expiry, current-eligibility checks, idempotency fingerprints, private evidence handling, or receipt audience binding to improve convenience.
