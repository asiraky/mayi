# Package releases

Mayi publishes exactly two npm packages: `@mayi/sdk` and `@mayi/eve`.
`@mayi/contracts` is bundled into the SDK build and remains private, as do all
other workspace packages. Package versions are independent.

## Contributor flow

For a publishable pull request, run `pnpm changeset`, select every affected
public package, choose the SemVer bump, and write the user-facing changelog
summary. Commit the generated `.changeset/*.md` file with the code.

For internal-only, test-only, or documentation-only work, run
`pnpm changeset --empty` and commit that empty changeset. This is the explicit
no-release path. CI rejects pull requests that record neither release intent.

After changes land on `main`, `.github/workflows/release.yml` runs the full
verification suite and Changesets opens or updates `chore: version packages`.
That reviewable PR applies independent versions, updates workspace dependency
ranges, consumes changeset files, and writes package changelogs. Merging that
specific PR is the only publish trigger. Developers never run `npm publish` or
`pnpm release` on a laptop.

## Prereleases

Prereleases are deliberate and use only the `next` npm dist-tag:

```sh
pnpm changeset pre enter next
pnpm changeset
```

Commit `.changeset/pre.json` and the changeset, review the generated prerelease
versions, and merge the version PR normally. The guarded publish script detects
the prerelease version and invokes Changesets with `--tag next`; unstable builds
never move `latest`. When the prerelease series is complete, run
`pnpm changeset pre exit`, add the final release changeset if needed, and review
the stable version PR before it can update `latest`.

## One-time npm and GitHub setup

An owner must supply the `@mayi` npm organization and ownership of both package
records. Do not merge a version PR until both packages expose npm package
settings. For **each** of `@mayi/sdk` and `@mayi/eve`, configure this exact npm
Trusted Publisher:

| npm field | Exact value |
| --- | --- |
| Provider | GitHub Actions |
| GitHub organization or user | `asiraky` |
| Repository | `mayi` |
| Workflow filename | `release.yml` |
| Environment | `npm-production` |
| Allowed action | `npm publish` only |

The package `repository.url` values must remain exactly
`https://github.com/asiraky/mayi`. The workflow uses GitHub-hosted runners,
Node 24, npm 11.18.0, `id-token: write`, public access, and OIDC. It deliberately
has no `NPM_TOKEN`; npm produces provenance automatically for a public package
published from this public repository through Trusted Publishing.

In GitHub, create a protected `npm-production` environment, restrict deployment
to `main`, and add required reviewers. Permit GitHub Actions to create pull
requests so Changesets can maintain the version PR. Release concurrency allows
only one npm publish job at a time.

After the first OIDC publish succeeds for both packages, set each npm package's
publishing access to **Require two-factor authentication and disallow tokens**,
then revoke obsolete npm automation tokens. Do not add a long-lived token to the
repository, environment, or workflow during bootstrap.

## Pipeline and dry run

The package verification job installs from `pnpm-lock.yaml` without a dependency
cache, migrates a PostgreSQL service, and runs lint, typecheck, tests, all builds,
both existing `pnpm pack` artifact inspections, and both clean-fixture install /
runtime-import / type-resolution tests. Before publishing, the guarded script
checks the exact merged commit, OIDC environment, npm CLI floor, public-package
allowlist, intended npm versions, and immutable tag names.

**Actions → Release → Run workflow** is dry-run only. It exercises that same
verification job and `pnpm release:dry-run`; no publish job is eligible on a
`workflow_dispatch` event. The dry-run command itself never invokes Changesets
publish, npm publish, git push, or GitHub release creation.

Each published package gets its own immutable tag and GitHub release, such as
`@mayi/sdk@0.2.0`, at the exact version-PR merge commit. Release notes come from
that package's generated changelog. Existing npm versions and tags are never
overwritten.

## Failure, recovery, and rollback

If verification or the registry preflight fails, fix the cause and rerun before
anything is published. If a multi-package publish stops partway through, inspect
npm, the package tags, and GitHub releases separately; never delete or replace a
published tarball. Continue only the still-unpublished version and create any
missing immutable tag/release at the original version commit.

For a bad release, deprecate the immutable version with a precise warning,
prepare a corrective changeset, and publish a new version through a new version
PR. Move consumers to the fix. Never unpublish and republish the same version,
force-push a package tag, edit a GitHub release to imply different contents, or
publish from a workstation.
