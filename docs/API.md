# Service contract

Agents authenticate with OAuth PKCE at the advertised well-known endpoints or an administrator-created bearer token. The remote MCP endpoint is `/api/mcp`; the compatibility tools are `create_approval`, `get_approval`, and `cancel_approval`.

Dynamic OAuth registration requires both exact `redirect_uris` and exact
`approval_callback_uris`. Redirect URIs must be HTTPS on the default port, or
loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`, any port) for RFC 8252
native apps. Approval callbacks are immutable client metadata and
are authorized against the client ID bound to the agent's access token. If an
agent's stable callback origin changes, register a new OAuth client and reconnect
it; then revoke the old connection through the agent disconnect flow. Existing
tokens remain bound to the old client and never inherit the replacement client's
callback URLs.

The authorization request accepts two optional parameters beyond standard
PKCE. `label` (at most 100 characters) names this installation of the client; it
is shown on the consent screen and becomes the connection's name, so several
installations of one client stay distinguishable. `connection` carries the
`agent_id` of an existing connection to reconnect it: the token exchange then
renews credentials on that same agent instead of creating a new one, so the
approvals and inputs it already requested, and its idempotency keys, stay
reachable. Every token response, including refreshes, returns `agent_id`; hosts
should store it and send it as `connection` whenever they re-run the browser flow
for an installation that was connected before.

A reconnect must be consented to from the workspace that owns the connection and
use the same OAuth client. Otherwise the consent screen stops with an error and
an option to switch account; it never falls back to creating a fresh connection.
All refresh tokens issued before a reconnect are revoked. A connection revoked
automatically after refresh-token reuse can be reconnected. A connection revoked
by a workspace owner cannot: that revoke is final, and the host must start a new
connection by omitting `connection`.

The SDK never owns this OAuth session. The embedding host runs the browser
Authorization Code + PKCE flow, stores and rotates the refresh grant, and
supplies current access tokens to the SDK or Eve adapter.

HTTP agents use `POST /api/approvals` with `Idempotency-Key`, upload private evidence to `POST /api/approvals/:id/artefacts?filename=...`, then seal with `POST /api/approvals/:id/seal`. Users list, inspect, and decide through the same approval resources. A target verifies the JWS against `/.well-known/jwks.json`; consumed receipts are posted with exact action and manifest digests to `/api/receipts/consume`.

No-artifact OAuth agents use `POST /api/approvals/request` with an
`Idempotency-Key`, action, optional `suggestedApproverId`, expiry, and per-request callback. The callback
must exactly match an approval callback URI registered to the OAuth client bound
to the bearer token and must pass the public-HTTPS policy at request time. The
endpoint atomically creates and seals the approval, freezes its empty-manifest
digests and eligible approvers, stores callback state as opaque text, queues the
normal pending notifications, and returns `PENDING` without waiting for a human.

The public-HTTPS check has two runtime implementations. Node and Vercel connect
to the validated IP address while preserving the original Host header and TLS
SNI. Cloudflare Workers cannot pin the connection address, so the edge path
immediately re-resolves DNS and sends a `redirect: "error"` fetch. Both reject a
URL when any answer is non-public, but only the Node transport provides
connection pinning.

When that approval becomes approved, denied, expired, or cancelled, the same
database transaction activates its callback outbox row. Delivery posts a
canonical JSON body signed by `X-Mayi-Signature`; the signing keys are published
at `/.well-known/jwks.json`. The version 1 event is intentionally minimal:

```json
{
  "id": "AbCdEfGhIjKl",
  "type": "approval.resolved",
  "version": 1,
  "approvalId": "MnOpQrStUvWx",
  "status": "approved",
  "state": "<opaque ciphertext>",
  "occurredAt": "2026-07-15T00:00:00.000Z",
  "approver": { "id": "YzAbCdEfGhIj" },
  "receipt": "<approved receipt>"
}
```

`approver` is present only for approved and denied decisions. `receipt` is
present only for approved decisions. `id` and `occurredAt` are stable across
retries and manual replay. Consumers should deduplicate on `id`, verify the
compact EdDSA JWS against the raw canonical body with `@mayiapp/sdk`, and return any
2xx status for both first acceptance and duplicate acceptance. Mayi stores and
echoes `state` unchanged and never parses or logs it.

## Review content and revisions

Every approval create path (`POST /api/approvals/request`, `POST /api/approvals`
+ seal, and MCP `create_approval`) accepts three optional fields:

- `title`: one line, 1–200 characters, not blank. Leads the approval in the
  app and in the notification email.
- `reviewMarkdown`: a Markdown document (CommonMark + GFM tables), 1–100000
  characters, not blank. The web app renders it without raw HTML or images. It
  is explanatory only: May I? never interprets it for authorization, and it is
  never included in email.
- `supersedesApprovalId`: a previous approval this request revises.

These fields are part of the idempotency fingerprint. Reusing an
`Idempotency-Key` with a different title or document returns `409`.

Every approval response carries:

- `title`, `reviewMarkdown`, and `supersedesApprovalId`, as sent, or `null`.
- `reviewDigest`: always set, including when neither title nor document was given.
- `supersededByApprovalId`: the revision that replaced this approval, or `null`.
- `decisionOutcome`: `APPROVED`, `DENIED`, `CHANGES_REQUESTED`, or `null`
  while undecided or when the approval expired or was cancelled.
- `reviewUrl`: the stable link a person opens to review the approval:
  `<WEB_ORIGIN>/?approval=<id>`. It falls back to `PUBLIC_ORIGIN`, then
  `http://localhost:3000`. The notification email uses the same link.

`reviewDigest` is the lowercase hex SHA-256 of the canonical JSON (sorted keys,
no whitespace) of `{ explanation, reviewMarkdown, title, v: 1 }`. Absent fields
are `null`. `@mayiapp/sdk` exports `reviewDigest()` to compute it. An approved
receipt carries the frozen value as its `review_digest` claim, so a target can
check which proposal the receipt authorizes. The action, explanation, title,
document, digest, and revision link cannot be changed after creation; the
database rejects any update to them.

### Requesting changes

A reviewer decides with `POST /api/approvals/:id/decision` and a body of
`{ decision: "APPROVED" | "DENIED" | "CHANGES_REQUESTED", comment? }`.
`CHANGES_REQUESTED` needs a non-blank `comment` of at most 4000 characters, or
the request fails with `422`. Requesting changes is a denial: `state` becomes
`DENIED`, `decisionOutcome` becomes `CHANGES_REQUESTED`, and no receipt is
issued. The audit event is `approval.changes_requested`.

The version 1 `approval.resolved` callback is unchanged. It reports
`status: "denied"` with `approver`. To tell the two kinds of denial apart and
read the feedback, the integration fetches `GET /api/approvals/:id` with its
agent token and reads `decisionOutcome` and `decisionComment`.

### Revisions

To answer feedback, create a new approval with `supersedesApprovalId` set to the
approval you are replacing. That approval must:

- have been created by the same agent. Otherwise the request fails with `422`,
  as it does for an ID that doesn't exist or belongs to another workspace.
- be resolved (approved, denied, expired, or cancelled). A pending approval
  returns `409`; cancel it first.
- not already have a revision. A second revision returns `409`, including when
  two requests race.

The earlier approval then reports the new one as `supersededByApprovalId`.

## Inputs (generic human input)

Questions with no action to enforce — freeform text, a pick from a list, a
plain confirmation — use `POST /api/inputs` with an `Idempotency-Key`. The body
carries `type` (`"text"`, `"select"`, or `"confirmation"`), `prompt`, `options`
(required for select and confirmation; 1–20 options for select, exactly 2 for
confirmation, each `{ id, label, description?, style? }` with unique ids),
`allowFreeform` (select only), `expiresInSeconds` (60–604800), an optional
`suggestedApproverId`, and an optional `callback` `{ url, state }`. Text
questions take no options. Agents reuse the approval scopes — `approval:create`
to create, `approval:cancel` to cancel — with no separate input scopes.

`GET /api/inputs/:id` and `GET /api/inputs?state=` mirror the approval
resources. `POST /api/inputs/:id/answer` is the app-side endpoint an eligible
respondent answers through with `{ optionId }` and/or `{ text }`; the server
requires `optionId` to name a listed option and accepts `text` only where the
type or `allowFreeform` allows it. `POST /api/inputs/:id/cancel` is agent-side.
States are `PENDING`, `ANSWERED`, `EXPIRED`, and `CANCELLED`.

The callback is optional. When present it follows the approval callback rules
exactly — registered `approval_callback_uris`, the public-HTTPS policy, opaque
`state` echoed unchanged — and resolution activates the same signed outbox with
the same retry and replay behaviour. Agents that omit it poll
`GET /api/inputs/:id` instead. The version 1 event:

```json
{
  "id": "AbCdEfGhIjKl",
  "type": "input.resolved",
  "version": 1,
  "inputId": "MnOpQrStUvWx",
  "status": "answered",
  "state": "<opaque ciphertext>",
  "occurredAt": "2026-07-15T00:00:00.000Z",
  "respondent": { "id": "YzAbCdEfGhIj", "email": "dana@example.com" },
  "answer": { "optionId": "hotfix" },
  "attestation": "<signed answer attestation>"
}
```

`respondent`, `answer`, and `attestation` are present only for
`status: "answered"`; expired and cancelled events carry the base fields only.
Delivery is signed with the same `X-Mayi-Signature` EdDSA JWS as
`approval.resolved` and verifies against `/.well-known/jwks.json`; the
`@mayiapp/sdk` webhook verifier accepts both event types.

The attestation is a durable Mayi-signed JWT recording who answered, what, and
when: respondent, input type, prompt digest, the answer and its digest, and the
answered-at time. It deliberately carries no expiry claim — it is provenance an
agent can persist and re-verify against the published JWKS, not an enforcement
token. Signing keys rotate and `/.well-known/jwks.json` retains a bounded set of
previous keys, so an attestation verifies there for as long as its signing key
remains published; consumers that need to re-verify indefinitely should verify
on receipt and/or pin the signing public key (the JWT's `kid` identifies it)
alongside the stored attestation. Enforcement — verify-against-action,
consume-once — remains approval-only, because only an approval authorises a
specific action.

Webhook destinations are ownership-verified at creation, then selected by server-owned forwarding rules. Every delivery carries `X-Mayi-Signature`. Decision assertions are compact JWS values posted to `/api/forwarding/assertions` and must bind the destination, workspace, request, digests, policy, actor, nonce, decision, and time window.

Every account starts with two default notification channels: signup creates a
born-verified EMAIL destination for the account address with an active
catch-all rule (signing up asserts ownership of that address), and mobile push
is fanned out to registered devices unconditionally, with no forwarding row
required. The code-verification flow in `/api/forwarding/email/start` +
`/confirm` applies to any additional address a workspace owner adds.

Per-request terminal callbacks are separate from forwarding destinations and
rules. Forwarding continues to emit only `mayi.approval_pending`.

Tool-call approvals use the exact `{ kind: "tool-call", toolName, callId, input }`
shape and carry no `audience`; OAuth client identity is enforced by request
authentication and callback authorization instead. These calls are
cooperatively enforced. May I? can issue `verified` or `consumed` enforcement
only for a versioned action whose executor-owned schema is registered, because
it cannot otherwise prove what an arbitrary tool executor ran.
