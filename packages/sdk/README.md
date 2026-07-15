# `@mayi/sdk`

ESM-first TypeScript client and security utilities for [May I?](https://mayi.sh), an approval service for software agents.

## Install

```sh
npm install @mayi/sdk
```

## Client

```ts
import { MayiClient } from "@mayi/sdk";

const mayi = new MayiClient({
  origin: "https://mayi.example.com",
  getAccessToken: async () => hostOAuthSession.getAccessToken(),
});

const approval = await mayi.approvals.request(request, {
  idempotencyKey: requestId,
});
```

The token provider is called for each authenticated request. The SDK does not store OAuth access or refresh tokens.

Security helpers can be imported from the main entry or directly from their subpaths:

```ts
import { createCallbackStateCodec } from "@mayi/sdk/callback-state";
import { createWebhookVerifier } from "@mayi/sdk/webhook-verifier";
```

## Runtime support

- Node.js 22 and later.
- Modern browsers and edge runtimes that provide Fetch, Web Crypto, `TextEncoder`/`TextDecoder`, base64 globals, and `AbortController`.

The `mayi` CLI is Node-only. Browser and edge support describes the standards-based library entry points; individual runtimes are not separately certified.

This package ships ESM JavaScript, TypeScript declarations, and source maps. CommonJS `require()` is not supported.

Licensed under the [Apache License 2.0](LICENSE).
