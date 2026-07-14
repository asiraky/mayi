# Service contract

Agents authenticate with OAuth PKCE at the advertised well-known endpoints or an administrator-created bearer token. The remote MCP endpoint is `/api/mcp`; the compatibility tools are `create_approval`, `get_approval`, and `cancel_approval`.

HTTP agents use `POST /api/approvals` with `Idempotency-Key`, upload private evidence to `POST /api/approvals/:id/artefacts?filename=...`, then seal with `POST /api/approvals/:id/seal`. Users list, inspect, and decide through the same approval resources. A target verifies the JWS against `/.well-known/jwks.json`; consumed receipts are posted with exact action and manifest digests to `/api/receipts/consume`.

Webhook destinations are ownership-verified at creation, then selected by server-owned forwarding rules. Every delivery carries `X-Mayi-Signature`. Decision assertions are compact JWS values posted to `/api/forwarding/assertions` and must bind the destination, workspace, request, digests, policy, actor, nonce, decision, and time window.
