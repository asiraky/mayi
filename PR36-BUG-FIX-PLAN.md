# PR #36 Bug-Fix Plan

This plan covers only the correctness and security defects accepted from the
adversarial review of PR #36. Historical API/data compatibility, generic auth
error UX, mutable artefact-hook output, and documentation-only issues are out of
scope.

## 1. Fence every outbox job attempt

**Severity:** High

### Bug

`claimNextJob()` assigns a lease token and increments the attempt number for all
jobs, but push, forwarding-webhook, and email completion/failure updates match
only the job ID. A worker whose lease has expired can therefore overwrite the
state written by a newer worker. In addition, a successful external delivery is
marked `SUCCEEDED` before its success audit is written; if the audit fails, the
shared catch block changes the successfully delivered job back to `FAILED` or
`DEAD_LETTER`.

Unbounded forwarding and email requests make stale-lease reclamation a
realistic interleaving.

### Required change

- Apply the callback job's fencing model to every job type.
- Every completion or failure mutation must require all of:
  - matching job ID;
  - `state = 'RUNNING'`;
  - matching attempt number;
  - matching lease token.
- Treat a zero-row update as a stale outcome and do not alter the newer attempt.
- Put delivery state mutation and its audit in a transaction where appropriate,
  or make post-success auditing unable to reclassify a delivered job as failed.
- Add bounded connect/response/total timeouts to forwarding and email requests.
- Use provider/delivery idempotency identifiers where the external provider
  supports them; database fencing cannot retract a side effect already sent.

### Verification

- A stale worker cannot overwrite a reclaimed worker's success.
- A stale success cannot overwrite a newer failure/dead-letter outcome.
- An audit failure after delivery does not schedule duplicate delivery.
- Timeout tests prove external requests finish before the lease expires.
- Add integration coverage for stale push, forwarding-webhook, and email jobs,
  not only callback jobs.

### Primary files

- `apps/server/server/utils/callback-outbox.ts`
- `apps/server/server/api/internal/jobs/drain.post.ts`
- `apps/server/server/utils/callback-outbox.integration.test.ts`

## 2. Define a real end-to-end callback acceptance window

**Severity:** High

### Bug

Eve accepts webhook events and callback state for approximately 3,833 seconds.
That value covers only the maximum sum of exponential backoffs. It does not
cover request execution time, cron/scheduler delay, deployment downtime, queue
delay, or the documented manual replay of a dead-letter callback.

Consequently, a legitimate late automatic attempt can be rejected as stale,
and a manual replay can be permanently unusable because both the signed event
and encrypted callback state retain their original timestamps.

### Required change

- Define one shared callback acceptance/retention policy covering:
  - approval lifetime;
  - all automatic retry delays;
  - maximum transport execution time;
  - scheduler/queue delay;
  - a documented operational outage/manual-replay allowance.
- Use that policy consistently for:
  - encrypted callback-state expiry;
  - webhook maximum event age;
  - signing-key retention guidance;
  - callback/outbox retention and operational documentation.
- Decide explicitly whether manual replay retains the original event identity
  and occurrence time or creates a new versioned delivery event. Preserve
  duplicate-safety either way.
- Do not solve this only by adding a few transport seconds to the existing
  backoff sum; manual replay needs an explicit supported window.

### Verification

- The final automatic attempt remains acceptable under maximum backoff,
  transport time, and scheduler delay.
- A dead-letter callback can be replayed after the documented operational delay.
- State decryption, event-age validation, and retained signing keys remain valid
  for the same documented period.
- Events outside that period still fail closed.

### Primary files

- `packages/eve/src/channel.ts`
- `packages/sdk/src/callback-state.ts`
- `packages/sdk/src/webhook-verifier.ts`
- `apps/server/server/utils/callback-outbox.ts`
- `docs/OPERATIONS.md`

## 3. Make staged-artefact cleanup crash consistent

**Severity:** High

### Bug

Expired staged cleanup deletes the immutable object inside a database
transaction and then deletes the database row. Object deletion is irreversible,
but the database transaction can roll back. If object deletion succeeds and SQL
deletion or commit fails, the `READY` row survives while its object is missing.

An exact upload retry currently trusts a `READY` row and skips object
verification. The final approval request can therefore claim and bind evidence
that cannot be downloaded.

### Required change

- Introduce a crash-consistent cleanup lifecycle, for example:
  1. transactionally mark an expired unbound row `DELETING`;
  2. commit that state;
  3. idempotently delete the object;
  4. delete the row in a second transaction.
- Make cleanup retries resume `DELETING` rows.
- Never select or delete bound artefacts.
- Make upload replay and final request claiming reject `DELETING` rows.
- Verify the object before trusting a recoverable `READY` upload reservation, or
  otherwise ensure cleanup can never leave `READY` without storage.
- Prefer a leaked unreferenced object after a crash over a live database
  reference to a missing object; leaked storage can be reconciled later.

### Verification

- Inject failure after marking, after object deletion, during row deletion, and
  during database commit.
- Every failure converges through retry to both row and object deleted.
- No failure leaves a claimable row whose object is absent.
- Concurrent approval claiming and cleanup serialize safely.

### Primary files

- `apps/server/server/utils/staged-artefact-cleanup.ts`
- `apps/server/server/api/approvals/request/artefacts/[ordinal].post.ts`
- `apps/server/server/api/approvals/request.post.ts`
- `packages/db/src/schema.ts`
- `packages/db/drizzle/`

## 4. Refuse cleartext SDK origins by default

**Severity:** High

### Bug

`MayiClient` accepts arbitrary HTTP origins and sends OAuth bearer tokens,
approval contents, and artefact bodies to them. A typo or malicious
configuration can therefore disclose credentials and evidence to an on-path
attacker.

### Required change

- Require HTTPS origins by default.
- If local HTTP development is necessary, allow it only when all of the
  following hold:
  - the hostname is an exact loopback host/address;
  - an explicitly named insecure-development option is enabled;
  - credentials, paths, query strings, and fragments remain forbidden.
- Do not permit arbitrary private-network or public HTTP origins.
- Keep the option visibly dangerous and unsuitable for production.

### Verification

- Arbitrary `http://example.com`, private-network, and non-loopback origins are
  rejected before token acquisition or fetch.
- HTTPS continues to work.
- Explicit loopback development works only with the opt-in.
- Tests prove rejected configuration never calls `getAccessToken` or `fetch`.

### Primary files

- `packages/sdk/src/index.ts`
- `packages/sdk/src/index.test.ts`
- `packages/sdk/README.md`

## 5. Preserve DNS pinning for forwarding webhooks

**Severity:** Medium-High

### Bug

Forwarding URL validation resolves the hostname and confirms that every address
is public, but the forwarding helper discards the validated pinned address and
returns only the URL. Delivery then uses ordinary `fetch()`, causing a second DNS
lookup. An attacker-controlled hostname can change from a public address during
validation to a private/link-local address during delivery.

### Required change

- Preserve the complete validated target, including its pinned address.
- On Node, deliver through a transport that connects to the pinned address while
  preserving the original Host header and TLS SNI, as the approval callback
  transport already does.
- Revalidate immediately before every delivery attempt.
- Continue refusing redirects.
- For edge runtimes that cannot pin a transport address, either fail closed or
  use a documented platform egress control that guarantees public-only targets.
- Apply the same protection to destination verification and actual delivery.

### Verification

- A hostname that changes from a public to private answer cannot receive a
  verification or delivery request.
- TLS hostname verification still uses the original hostname.
- Redirects remain refused.
- Multi-address hosts are accepted only when all resolved addresses are public.
- Tests cover DNS rebinding between validation and connection.

### Primary files

- `apps/server/server/utils/forwarding.ts`
- `apps/server/server/utils/public-url.ts`
- `apps/server/server/api/forwarding/destinations.post.ts`
- `apps/server/server/api/internal/jobs/drain.post.ts`

## 6. Enforce request-body limits while streaming

**Severity:** Medium

### Bug

Several routes buffer the complete request before checking its advertised
maximum size. Chunked requests can omit or falsify `Content-Length`, forcing the
runtime to allocate attacker-controlled bodies before the application rejects
them.

Affected boundaries include:

- staged artefact upload (25 MiB);
- public OAuth client registration (32 KiB);
- the public Eve approval callback (128 KiB).

### Required change

- Add a shared bounded-body reader that counts bytes while streaming.
- Cancel the reader immediately after `limit + 1` bytes.
- Treat `Content-Length` as a useful preflight rejection only, never as the
  authoritative size.
- Configure corresponding hard body limits at Nitro/deployment boundaries where
  supported, while keeping application enforcement authoritative.
- Avoid producing error objects that include rejected body contents.

### Verification

- Chunked oversized bodies are aborted after at most `limit + 1` bytes.
- A false small `Content-Length` cannot bypass the actual limit.
- An oversized declared length is rejected before reading the body.
- Boundary-sized requests succeed and one-byte-oversized requests fail.
- Tests use streaming/chunked bodies rather than only preconstructed strings.

### Primary files

- `apps/server/server/api/approvals/request/artefacts/[ordinal].post.ts`
- `apps/server/server/api/oauth/register.post.ts`
- `packages/eve/src/channel.ts`
- `apps/server/nitro.config.ts`

## 7. Put OAuth registration behind a trustworthy attempt limit

**Severity:** Medium

### Bug

Dynamic OAuth registration derives its rate-limit key by unconditionally
trusting `X-Forwarded-For`, which is spoofable on a direct Node/VPS deployment or
through an incorrectly configured proxy. It also counts only successful
registrations after parsing and callback-host DNS validation. Attackers can
rotate the header to create unlimited clients or send unlimited invalid requests
that consume parsing and DNS resources without entering the limit.

### Required change

- Derive client IP only from a deployment-specific trusted source or an
  explicitly configured trusted-proxy chain.
- Do not enable generic forwarded-header trust unconditionally.
- Apply an attempt/token-bucket limit before body parsing and DNS resolution.
- Keep a separate successful-registration limit if useful for database growth.
- Bound concurrent DNS validation work and avoid resolving many callback hosts
  for an already-limited caller.
- Document the required trusted-proxy configuration for every supported target.

### Verification

- A caller cannot change its rate-limit identity with a supplied or multi-hop
  `X-Forwarded-For` header.
- Invalid JSON, invalid callbacks, and DNS failures consume the attempt budget.
- Parallel registration attempts cannot race around the limit.
- Direct Node, Vercel, and Cloudflare deployments use their intended trusted IP
  source.

### Primary files

- `apps/server/server/api/oauth/register.post.ts`
- `apps/server/server/utils/oauth-registration.test.ts`
- `docs/DEPLOYMENT.md`

## 8. Validate media signatures on every artefact upload path

**Severity:** Medium

### Bug

The request-staging upload route compares declared media type with magic bytes,
but the retained draft `create -> upload -> seal` route still trusts only the
`Content-Type` header. An authenticated agent can store arbitrary or polyglot
bytes labeled as a supported PDF/image and have them served inline as approval
evidence.

### Required change

- Use the shared artefact media-type, maximum-size, and signature detection logic
  in both upload routes.
- Store only the detected media type after confirming it matches the declaration.
- Reject empty, unsupported, or mismatched content before object storage.
- Keep `X-Content-Type-Options: nosniff`, restrictive rendering headers, and
  authorization on download as defence in depth.
- If the draft flow is no longer required, remove it and its SDK surface instead
  of retaining a weaker upload path.

### Verification

- Every upload path rejects mislabeled PDF, PNG, JPEG, and WebP bodies.
- Every upload path accepts valid signatures at size boundaries.
- A rejected upload creates no database row or object.
- Download responses retain safe content and authorization headers.

### Primary files

- `apps/server/server/api/approvals/[id]/artefacts.post.ts`
- `apps/server/server/api/approvals/request/artefacts/[ordinal].post.ts`
- `apps/server/server/utils/artefacts.ts`
- `packages/sdk/src/index.ts`

## Recommended implementation order

1. Fence all outbox jobs.
2. Establish the callback acceptance/replay policy.
3. Make staged cleanup crash consistent.
4. Require secure SDK origins.
5. Pin forwarding webhook delivery.
6. Add streaming request limits.
7. Harden registration rate limiting.
8. Unify artefact validation across upload paths.

After each change, run the focused integration tests. Before merging, run the
complete lint, typecheck, test, package-artifact, migration-generation, and build
checks used by CI.
