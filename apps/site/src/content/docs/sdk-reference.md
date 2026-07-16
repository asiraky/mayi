---
title: "SDK reference"
description: "The complete @mayiapp/sdk surface: client methods, types, errors, security helpers, and CLI."
order: 4
---

The complete public surface of `@mayiapp/sdk`. See [Agent integration](/docs/agent-integration) for the recommended flow. Everything below is exported from the package entry unless a subpath is noted.

## `MayiClient`

```ts
new MayiClient(options: MayiClientOptions)
```

```ts
interface MayiClientOptions {
  origin: string;                 // HTTPS origin, no path/query/credentials
  getAccessToken?: () => Promise<string>;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  dangerouslyAllowInsecureHttpForDevelopment?: boolean; // loopback HTTP only
}
```

`fetch` defaults to the runtime `globalThis.fetch`. Requests attach `Authorization: Bearer <token>` from `getAccessToken` when a method requires it; the SDK never stores the token.

### Approval methods

| Method | Description |
| --- | --- |
| `approvals.request(request, { idempotencyKey })` | Seal and submit a request in one call. Returns a `PendingApproval`. Requires an access token. |
| `stageRequestArtefact(requestKey, ordinal, filename, mediaType, body, options?)` | Stage evidence before `approvals.request`. Returns a `StagedArtefact`. |
| `approval(id)` | Fetch one approval by id. |
| `listApprovals(state?)` | List approvals, optionally filtered by state. |
| `cancel(id)` | Cancel a pending approval. Returns the updated `Approval`. |

```ts
approvals.request(
  request: ApprovalRequest,
  options: { idempotencyKey: string }, // 1–200 chars
): Promise<PendingApproval>

stageRequestArtefact(
  requestKey: string,          // 1–200 chars, matches the request idempotencyKey
  ordinal: number,             // integer 0–19
  filename: string,            // 1–255 chars
  mediaType: ArtefactMediaType,
  body: Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>,
  options?: { signal?: AbortSignal; size?: number },
): Promise<StagedArtefact>
```

### Lower-level draft flow

`approvals.request` is the recommended path. The multi-step draft flow builds an approval incrementally and is used by the application itself:

| Method | Description |
| --- | --- |
| `createApproval(input, idempotencyKey?)` | Create a `DRAFT`. `input` is a `CreateApproval` (this flow carries an explicit `enforcement` mode). |
| `uploadArtefact(id, filename, mediaType, body)` | Attach evidence to a draft. |
| `sealApproval(id, artefactIds)` | Freeze a draft into a `PendingApproval`. |
| `decide(id, { decision, comment? })` | Record an `APPROVED`/`DENIED` decision (approver-side). |

### Auth & account methods

`signup(input)`, `signin(input)`, `session()`, `signout()`, `stepUp(input)`, `activity()`, `agents()`, `createAgent({ name, scopes })`, `registerDevice(token, platform)`. These back the first-party web and mobile clients; an integrating agent normally needs only the approval methods above plus a `getAccessToken` provider.

## Types

```ts
type Action = ToolCallAction | VersionedAction;

type ToolCallAction = {
  kind: "tool-call";
  toolName: string;
  callId: string;
  input: Record<string, unknown>;
};

type VersionedAction = {
  kind: string;
  version: string;
  audience: string;
  input: Record<string, unknown>;
  resourceVersion?: string;
};

type ApprovalState = "DRAFT" | "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" | "CANCELLED";
type EnforcementMode = "cooperative" | "verified" | "consumed";
type ArtefactMediaType = "application/pdf" | "image/png" | "image/jpeg" | "image/webp";

interface ApprovalRequest {
  action: Action;
  explanation: string;
  suggestedApproverId?: string;
  expiresInSeconds: number;
  callback: { url: string; state: string };
  artefactIds?: string[];
}

interface CreateApproval {
  action: Action;
  explanation: string;
  expiresInSeconds: number;
  enforcement: EnforcementMode;
  suggestedApproverId?: string;
}

interface Approval {
  id: string;
  workspaceId: string;
  agentId: string;
  state: ApprovalState;
  action: Action;
  explanation: string;
  enforcement: EnforcementMode;
  actionDigest: string | null;
  manifestDigest: string | null;
  artefacts: Artefact[];
  createdAt: string;
  sealedAt: string | null;
  expiresAt: string;
  decidedAt: string | null;
  decisionComment: string | null;
  approverId: string | null;
  receipt?: string;
}

// PendingApproval narrows Approval: state "PENDING" with non-null
// sealedAt, actionDigest, and manifestDigest.
```

The approved variant of the resolved event carries the `receipt`:

```ts
type ApprovalResolvedEvent =
  | { type: "approval.resolved"; version: 1; id; approvalId; state; occurredAt;
      status: "approved"; approver: { id: string }; receipt: string }
  | { /* ... */ status: "denied"; approver: { id: string } }
  | { /* ... */ status: "expired" }
  | { /* ... */ status: "cancelled" };
```

## Errors

Every error is a named subclass of `Error`, so callers can branch on `instanceof` and, where present, a `code`:

- `MayiConfigurationError` — invalid client options or method arguments.
- `MayiAuthenticationError` — `code`: `ACCESS_TOKEN_PROVIDER_REQUIRED` | `ACCESS_TOKEN_UNAVAILABLE`.
- `MayiNetworkError` — the request could not reach the service.
- `MayiHttpError` — `status` (HTTP status); `code` is `step_up_required` when a 403 asks for re-authentication.
- `MayiResponseError` — the service returned a response that failed schema validation.

## Callback state — `@mayiapp/sdk/callback-state`

Bind opaque callback state to the parked continuation with an authenticated, encrypted (AES-256-GCM) envelope. Seal it into `callback.state` on the request; open it when the resolved event arrives.

```ts
import { createCallbackStateCodec } from "@mayiapp/sdk/callback-state";

const codec = await createCallbackStateCodec({
  currentKey: { kid: "2026-07", key: base64UrlKeyOr32Bytes },
  previousKeys: [],               // for key rotation
  maximumRetryWindowSeconds: 7 * 24 * 60 * 60,
});

const sealedCallbackState = await codec.seal(
  { continuationId: "…" },
  { approvalExpiresAt: expiresAtIso },
);

const payload = await codec.open<{ continuationId: string }>(event.stateFromYourRecord);
```

Also exported: `CALLBACK_ACCEPTANCE_WINDOW_SECONDS` (the shared seven-day acceptance window — use it for state retention), and the `CallbackStateConfigurationError` / `CallbackStateError` classes with `code` fields.

## Webhook verification — `@mayiapp/sdk/webhook-verifier`

Verify the `X-Mayi-Signature` on an incoming callback against May I?'s JWKS (`/.well-known/jwks.json`, Ed25519) before trusting the body. The verifier checks the signature, event age, optional issuer/audience, and (via your `isProcessed` callback) duplicate delivery.

```ts
import { createWebhookVerifier } from "@mayiapp/sdk/webhook-verifier";

const verifier = createWebhookVerifier({
  mayiOrigin: "https://app.mayi.sh",
  maximumEventAgeSeconds: 7 * 24 * 60 * 60,
  isProcessed: async (eventId) => store.has(eventId), // idempotency
});

const result = await verifier.verify({
  body: rawBody,                          // exact bytes, unparsed
  signature: request.headers.get("x-mayi-signature"),
});

if (result.duplicate) return; // already handled result.eventId
handleResolved(result.event); // verified ApprovalResolvedEvent
```

Also exported: `MAYI_JWKS_PATH`, `MAYI_SIGNATURE_HEADER`, `MAX_WEBHOOK_BODY_BYTES`, and the `WebhookConfigurationError` / `WebhookVerificationError` classes with `code` fields.

## CLI

The package ships a Node-only `mayi` binary:

```sh
mayi list            # list approvals
mayi get <id>        # fetch one approval
mayi cancel <id>     # cancel a pending approval
```

It reads `MAYI_ACCESS_TOKEN` (required) and defaults `origin` to `https://app.mayi.sh`; override with `MAYI_URL`. Local loopback use requires both a loopback `MAYI_URL` and `MAYI_ALLOW_INSECURE_LOOPBACK=true`.
