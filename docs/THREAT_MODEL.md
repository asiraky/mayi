# Threat model

## Trust boundary

May I? records and signs decisions; it does not execute actions. An approval is strongly enforced only when the relying target validates the signature, issuer, audience, time window, exact canonical action digest, artefact-manifest digest, and (for consumed mode) atomically consumes the receipt before applying its own resource precondition.

Custom actions are cooperative. Typed actions include a schema version and all target-owned security-relevant inputs.

## Principal threats and controls

| Threat | Control |
| --- | --- |
| Compromised agent | Narrow grants/scopes, server-owned approver policy, immutable sealing, bounded expiry, revocation |
| Cross-tenant access | Workspace-scoped repositories, compound foreign keys, transaction-local tenant context, RLS migration, direct-ID tests |
| Concurrent decisions | Row lock plus database-time expiry check in one serializable transaction |
| Action/evidence substitution | RFC 8785-style canonical JSON digest and ordered SHA-256 artefact manifest in signed receipt |
| Receipt replay | Audience binding, short expiry, unique ID, atomic one-time consumption |
| Stolen credentials | Only token hashes stored, rotating refresh/session tokens, revocation, recent-auth requirement for high risk |
| Approval-link scanners | Links contain identifiers only; GET never mutates; authenticated POST is required |
| Malicious documents | Private immutable originals; strict media/size limits; derivative processing belongs in isolated networkless workers and fails closed |
| SSRF/forwarding loops | Pre-registered verified destinations only, HTTPS/public-IP validation, redirect refusal, origin/hop/dedupe fields |
| Notification disclosure | Request ID and generic display string only; state refresh required before decisions |
| Audit tampering | Application writes through insert-only interface; DB role cannot update/delete audit events |

## Residual risks

Offline receipt verification cannot observe immediate revocation. Receipt consumption and the target mutation are not atomic across systems. A compromised eligible approver can approve until the account, membership, or credential is revoked; decision-time checks reduce but cannot erase that interval.
