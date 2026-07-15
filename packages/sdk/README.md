# `@mayi/sdk`

ESM-first TypeScript client and security utilities for [May I?](https://mayi.sh), an approval service for software agents.

## Install

```sh
npm install @mayi/sdk
```

## Quick start

```ts
import { MayiClient } from "@mayi/sdk";

const mayi = new MayiClient({
  origin: "https://mayi.example.com",
  getAccessToken: async () => hostOAuthSession.getAccessToken(),
});

const approval = await mayi.approvals.request({
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
}, { idempotencyKey: requestId });

console.log(approval.id, approval.status); // PENDING
```

The OAuth host owns the browser Authorization Code + PKCE flow, stores the
rotating refresh grant, refreshes it when needed, and supplies a current access
token. The token provider is called for each authenticated request. The SDK
stores no access token, refresh grant, browser session, or callback state.

Register every allowed terminal callback as immutable `approval_callback_uris`
metadata on that OAuth client. A stable-origin change requires a new client
registration, a fresh browser OAuth connection, and revocation of the old agent
connection; old tokens remain bound to the old client.

Security helpers can be imported from the main entry or directly from their subpaths:

```ts
import { createCallbackStateCodec } from "@mayi/sdk/callback-state";
import { createWebhookVerifier } from "@mayi/sdk/webhook-verifier";
```

Use the state codec to bind opaque callback state to the parked continuation,
then verify `X-Mayi-Signature` against the exact raw callback body before opening
state or resuming work. The callback is the primary completion path. Polling the
approval resource is a reconciliation/fallback mechanism.

May I? can strongly verify and consume only versioned actions backed by an
executor-owned schema. Arbitrary Eve-style tool-call actions have cooperative
enforcement: the executor must compare the reviewed call and enforce the result,
and May I? does not label those calls `verified` or `consumed`.

## Runtime support

- Node.js 22 and later.
- Modern browsers and edge runtimes that provide Fetch, Web Crypto, `TextEncoder`/`TextDecoder`, base64 globals, and `AbortController`.

The `mayi` CLI is Node-only. Browser and edge support describes the standards-based library entry points; individual runtimes are not separately certified.

This package ships ESM JavaScript, TypeScript declarations, and source maps. CommonJS `require()` is not supported.

Licensed under the [Apache License 2.0](LICENSE).
