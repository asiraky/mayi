# Service contract

Agents authenticate with OAuth PKCE at the advertised well-known endpoints or an administrator-created bearer token. The remote MCP endpoint is `/api/mcp`; the compatibility tools are `create_approval`, `get_approval`, and `cancel_approval`.

Dynamic OAuth registration requires both exact `redirect_uris` and exact
`approval_callback_uris`. Approval callbacks are immutable client metadata and
are authorized against the client ID bound to the agent's access token. If an
agent's stable callback origin changes, register a new OAuth client and reconnect
it; then revoke the old connection through the agent disconnect flow. Existing
tokens remain bound to the old client and never inherit the replacement client's
callback URLs.

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

Webhook destinations are ownership-verified at creation, then selected by server-owned forwarding rules. Every delivery carries `X-Mayi-Signature`. Decision assertions are compact JWS values posted to `/api/forwarding/assertions` and must bind the destination, workspace, request, digests, policy, actor, nonce, decision, and time window.

Per-request terminal callbacks are separate from forwarding destinations and
rules. Forwarding continues to emit only `mayi.approval_pending`.

Tool-call approvals use the exact `{ kind: "tool-call", toolName, callId, input }`
shape and carry no `audience`; OAuth client identity is enforced by request
authentication and callback authorization instead. These calls are
cooperatively enforced. May I? can issue `verified` or `consumed` enforcement
only for a versioned action whose executor-owned schema is registered, because
it cannot otherwise prove what an arbitrary tool executor ran.
