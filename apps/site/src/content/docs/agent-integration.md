---
title: "Agent integration"
description: "Add the May I? SDK to an agent and request a human decision before acting."
order: 3
---

An agent uses the `@mayiapp/sdk` TypeScript client to pause before a consequential action, describe that exact action, and wait for a person to approve or deny it. When the action is approved, May I? issues a signed receipt the agent's executor verifies before it proceeds.

## Install

```sh
npm install @mayiapp/sdk
```

The package is ESM-only and runs on Node.js 22+, modern browsers, and edge runtimes that provide Fetch, Web Crypto, `TextEncoder`/`TextDecoder`, base64 globals, and `AbortController`. `require()` is not supported.

## Create a client

```ts
import { MayiClient } from "@mayiapp/sdk";

const mayi = new MayiClient({
  origin: "https://app.mayi.sh",
  getAccessToken: async () => hostOAuthSession.getAccessToken(),
});
```

- `origin` is the May I? service. It must be an HTTPS origin with no path, query, or credentials (`https://app.mayi.sh`, or your self-hosted domain).
- `getAccessToken` returns a current bearer token. The OAuth host owns the browser Authorization Code + PKCE flow, stores the rotating refresh grant, refreshes it, and hands back a fresh access token for each request. The SDK stores no token, refresh grant, session, or callback state.

For local development against a loopback service only, cleartext HTTP can be enabled — never outside local development, because HTTP exposes bearer tokens and approval contents:

```ts
const localMayi = new MayiClient({
  origin: "http://127.0.0.1:3000",
  dangerouslyAllowInsecureHttpForDevelopment: true,
  getAccessToken,
});
```

## Request an approval

```ts
const approval = await mayi.approvals.request(
  {
    action: {
      kind: "tool-call",
      toolName: "deploy_release",
      callId: "call-42",
      input: { version: "2026.07.15" },
    },
    explanation: "Deploy the release that passed CI.",
    expiresInSeconds: 900,
    callback: {
      url: "https://agent.example/eve/v1/mayi/approval-resolved",
      state: sealedCallbackState,
    },
  },
  { idempotencyKey: requestId },
);

console.log(approval.id, approval.state); // "PENDING"
```

`approvals.request` seals the request in one call and returns a `PendingApproval` (`state: "PENDING"`). The `idempotencyKey` makes the call safe to retry: the same key returns the same approval instead of creating a second one.

The `callback.url` must be pre-registered as immutable `approval_callback_uris` metadata on the OAuth client. `callback.state` is opaque state you seal with the [callback-state codec](/docs/sdk-reference) so you can rebind the resolved event to the parked work.

### Actions

An action is one of two shapes:

- **`tool-call`** — an arbitrary tool invocation: `{ kind: "tool-call", toolName, callId, input }`. Enforcement is **cooperative**: May I? does not label these `verified` or `consumed`, so the executor must compare the reviewed call against what it is about to run and enforce the result itself.
- **versioned** — `{ kind, version, audience, input, resourceVersion? }`, backed by an executor-owned schema. May I? can strongly verify and consume these.

### Evidence

To attach supporting PDFs or images, stage each file with the request's idempotency key and its zero-based ordinal *before* requesting, then pass the returned IDs in order:

```ts
const requestKey = "deploy-2026-07-15";
const plan = await mayi.stageRequestArtefact(
  requestKey,
  0,
  "deployment-plan.pdf",
  "application/pdf",
  pdfBytes,
);

const approval = await mayi.approvals.request(
  {
    action,
    explanation: "Deploy the reviewed release.",
    expiresInSeconds: 3600,
    callback,
    artefactIds: [plan.id],
  },
  { idempotencyKey: requestKey },
);
```

Accepted media types are `application/pdf`, `image/png`, `image/jpeg`, and `image/webp`, up to 25 MiB each, ordinals `0`–`19`. An exact retry (same key, ordinal, bytes, and metadata) returns the same staged artefact; reusing the key and ordinal with different bytes is rejected. Staged evidence is claimed atomically when the approval becomes pending and expires after 24 hours if never claimed.

## Wait for the decision

The callback is the primary completion path. May I? POSTs a signed `approval.resolved` event to `callback.url`; verify the `X-Mayi-Signature` header against the raw body with the [webhook verifier](/docs/sdk-reference) before opening state or resuming work.

Polling is the reconciliation fallback:

```ts
const current = await mayi.approval(approval.id);
// current.state is one of PENDING | APPROVED | DENIED | EXPIRED | CANCELLED
```

## Enforce the receipt

An approved event and an approved approval carry a short-lived `receipt`. The executor still owns enforcement: before it deploys, deletes, transfers, or calls an external API, it verifies the receipt matches the exact action it is about to perform, and — for one-time (`consumed`) enforcement — consumes it. May I? issuing a receipt is a decision record, not permission for the runtime to skip that check.
