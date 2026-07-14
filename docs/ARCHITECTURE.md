# Architecture

Business rules live in portable TypeScript packages. Nitro is only the Web API/deployment boundary. PostgreSQL is authoritative for identity, policy, approval state, idempotency, jobs, receipts, and audit. Artefact bytes live behind a private object-store interface.

The server supports Node/VPS, Vercel, and Cloudflare presets. Hosting adapters supply the same `DATABASE_URL` protocol (Cloudflare uses a cache-disabled Hyperdrive connection string) and S3-compatible object credentials. No authorization read may use an HTTP/database cache.

The web and Expo clients share Zod contracts and SDK query logic, but own their views. MCP tools call the same application service used by HTTP routes.

## State transitions

`DRAFT -> PENDING -> APPROVED | DENIED | EXPIRED | CANCELLED`

Sealing freezes canonical action JSON, a sorted/ordered artefact manifest, policy version, and eligible approvers. Decisions lock the request and check database time, membership/credential state, sealed eligibility, and recent authentication for high-risk actions.
