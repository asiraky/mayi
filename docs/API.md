# Service contract

Agents authenticate with OAuth PKCE at the advertised well-known endpoints or an administrator-created bearer token. The remote MCP endpoint is `/api/mcp`; the compatibility tools are `create_approval`, `get_approval`, and `cancel_approval`.

Dynamic OAuth registration requires both exact `redirect_uris` and exact
`approval_callback_uris`. Approval callbacks are immutable client metadata and
are authorized against the client ID bound to the agent's access token. If an
agent's stable callback origin changes, register a new OAuth client and reconnect
it; then revoke the old connection through the agent disconnect flow. Existing
tokens remain bound to the old client and never inherit the replacement client's
callback URLs.

HTTP agents use `POST /api/approvals` with `Idempotency-Key`, upload private evidence to `POST /api/approvals/:id/artefacts?filename=...`, then seal with `POST /api/approvals/:id/seal`. Users list, inspect, and decide through the same approval resources. A target verifies the JWS against `/.well-known/jwks.json`; consumed receipts are posted with exact action and manifest digests to `/api/receipts/consume`.

No-artifact OAuth agents use `POST /api/approvals/request` with an
`Idempotency-Key`, action, optional `suggestedApproverId`, expiry, and per-request callback. The callback
must exactly match an approval callback URI registered to the OAuth client bound
to the bearer token and must pass the public-HTTPS policy at request time. The
endpoint atomically creates and seals the approval, freezes its empty-manifest
digests and eligible approvers, stores callback state as opaque text, queues the
normal pending notifications, and returns `PENDING` without waiting for a human.

Webhook destinations are ownership-verified at creation, then selected by server-owned forwarding rules. Every delivery carries `X-Mayi-Signature`. Decision assertions are compact JWS values posted to `/api/forwarding/assertions` and must bind the destination, workspace, request, digests, policy, actor, nonce, decision, and time window.
