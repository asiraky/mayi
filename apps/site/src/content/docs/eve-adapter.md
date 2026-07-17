---
title: "Eve adapter"
description: "Gate Eve agent tools behind a human decision with the @mayiapp/eve durable approval channel."
order: 5
---

`@mayiapp/eve` is a durable Mayi channel for [Eve](https://github.com/vercel/eve) agents. It turns an Eve `input.requested` into a May I? request, parks the session, and resumes it when a person decides — so a human-gated tool stays ordinary Eve code. An approve/deny confirmation becomes a May I? approval (with a signed receipt); every other `ask_question` — text, select, or a non-`approve`/`deny` confirmation — becomes a May I? input (with a signed answer attestation). It builds on [`@mayiapp/sdk`](/docs/agent-integration); you don't call the SDK directly.

## Install

```sh
npm install @mayiapp/eve eve
```

ESM-only, Node.js 24+, and pinned to the tested `eve@0.24.2` peer contract.

## Register the channel

```ts
// agent/channels/mayi.ts
import { mayiChannel } from "@mayiapp/eve";
import { credentials } from "../credentials.server";

export default mayiChannel({
  getAccessToken: () => credentials.getAccessToken("mayi"),
});
```

The host owns Mayi's Authorization Code + PKCE flow, stores and refreshes the OAuth grant, and returns a current token from `getAccessToken`. Neither the adapter nor the SDK stores tokens. Never put an access token, refresh token, static API key, or webhook endpoint ID in agent code. Eden's generated integration supplies this binding — see the [Eden agent template](https://github.com/asiraky/mayi/tree/main/packages/eve/examples/eden-agent).

## Gate a tool

An approval-gated tool is ordinary Eve code; the channel does the rest:

```ts
// agent/tools/deploy-production.ts
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Deploy a version to production.",
  inputSchema: z.object({ version: z.string() }),
  approval: always(),
  async execute({ version }) {
    return deployToProduction(version);
  },
});
```

Mayi handles `input.requested` only for sessions owned by the Mayi channel — it does not intercept Slack, Discord, the default HTTP channel, or other custom channels. Start any work that may need a Mayi approval on Mayi with Eve's `receive(mayi, …)`.

## Attach evidence

Approval happens *before* Eve calls the gated tool's `execute()`, so the `artefacts` hook can render from the proposed input, fetch an existing object, or read a file an earlier tool produced — but not the gated tool's own result, which doesn't exist yet.

```ts
export default mayiChannel({
  getAccessToken: () => credentials.getAccessToken("mayi"),
  async artefacts({ request, getSandbox, signal }) {
    const pdf = await renderDeploymentPlan(request.action.input, { signal });
    return [{ filename: "deployment-plan.pdf", mediaType: "application/pdf", body: pdf }];
  },
});
```

The hook receives the full Eve input `request`, a read-only `session` snapshot, `getSandbox()`, and an abort `signal`. Return at most 20 artefacts, each a PDF, PNG, JPEG, or WebP no larger than 25 MiB; returned order is the order shown to the approver and bound into the manifest. `undefined`, `null`, or an empty array preserves the no-evidence path. Hook, validation, timeout, or upload failures **fail closed** — Mayi never creates an approval with silently missing evidence. `artefactTimeoutMs` defaults to 30 seconds; pass its `signal` into your rendering, fetch, and file work.

## Scheduled and cross-channel handoff

Task-mode schedules can't park for human input. Use the handler form of an Eve schedule and hand the run to Mayi with `receive`:

```ts
// agent/schedules/check-production.ts
import { defineSchedule } from "eve/schedules";
import mayi from "../channels/mayi";

export default defineSchedule({
  cron: "0 * * * *",
  run({ receive, waitUntil, appAuth }) {
    waitUntil(receive(mayi, {
      message: "Check production and deploy if needed.",
      target: { mayiUserId: "AbCdEfGhIjKl" },
      auth: appAuth,
    }));
  },
});
```

The same pattern moves a custom channel route onto Mayi. `target.mayiUserId` is optional; when set it must be a 12-letter Mayi user ID and is sent as the suggested approver. The caller supplies the message, target, and Eve auth context; the adapter owns the continuation token and durable channel state.

## Callback route and resume semantics

`mayiChannel()` registers exactly this route in the deployed Eve service:

```text
POST /eve/v1/mayi/approval-resolved
```

You do not author that route, its URL, encrypted state, a correlation table, or a signature verifier. The adapter derives the callback URL from the stable public Eve base URL; register that exact HTTPS URL in the OAuth client's immutable `approval_callback_uris`. Do not invent a `/channels/mayi/...` prefix — Eve 0.24.2 compiles `route.path` verbatim, so a namespaced path registers the wrong callback and 404s.

For every delivery the adapter verifies Mayi's EdDSA JWS against Mayi's JWKS before touching encrypted state, then resumes the original Eve request against its continuation token. `approved` chooses Eve's `approve`; `denied`, `expired`, and `cancelled` choose `deny` (the session resumes but the tool does not run). Delivery is at least once and duplicate-safe: Eve's continuation fence means retrying the same stable event ID cannot run the tool twice, and the signed event stays acceptable for seven days after resolution.

Hosts with a durable event store can pass an `eventStore`:

```ts
mayiChannel({
  getAccessToken,
  eventStore: {
    isProcessed: (eventId) => db.hasProcessed(eventId),   // after Eve accepts the resume
    markProcessed: (eventId) => db.markProcessed(eventId), // after acceptance only
  },
});
```

The duplicate check runs only after webhook verification, and `markProcessed` only after Eve accepts, so a crash before acceptance leaves the event retryable. The hook is optional — ordinary Eden integrations rely on Eve's durable acceptance check.

## Configuration

`mayiChannel(config)` accepts:

| Option | Purpose |
| --- | --- |
| `getAccessToken` | **Required.** Returns a current Mayi access token. |
| `mayiOrigin` | Mayi API/JWKS origin. Defaults to `MAYI_ORIGIN`, then `https://app.mayi.sh`. |
| `publicOrigin` | Explicit HTTPS base URL for local dev or a tunnel. Refused in production. |
| `approvalExpiresInSeconds` | Approval lifetime for sessions on this channel. Defaults to 3600; must be an integer 60–604800. |
| `artefacts` | Evidence hook (above). |
| `artefactTimeoutMs` | Per-request hook + upload budget. Defaults to 30 s. |
| `eventStore` | Optional durable duplicate fence (above). |
| `fetch`, `webhookFetch`, `callbackStateCodec`, `environment` | Advanced host/testing injection. |

The deployment host provisions these environment variables:

- `EVE_PUBLIC_ORIGIN` — the stable public HTTPS base URL of the deployed agent: an origin (`https://agent.example`), or an origin plus a path prefix (`https://eden.example/e/abc123def456`) on hosts that route instances by path prefix on a shared hostname. Not a preview URL, localhost, query string, or non-default port. On path-routed hosts the platform's ingress must strip the prefix before requests reach the instance — the adapter's registered callback route is always exactly `MAYI_CALLBACK_PATH`.
- `MAYI_CALLBACK_STATE_KEY_ID` — identifier for the current callback-state key.
- `MAYI_CALLBACK_STATE_KEY` — a stable base64url 32-byte encryption key.
- `MAYI_CALLBACK_STATE_PREVIOUS_KEYS` (optional) — JSON array of decrypt-only `{ "kid", "key" }` entries kept during key rotation.
- `MAYI_ORIGIN` (optional) — defaults to `https://app.mayi.sh`.

Keep callback-state keys stable across restarts and deploys; rotate by installing a new current key and retaining the old one in `MAYI_CALLBACK_STATE_PREVIOUS_KEYS` until outstanding approvals and the seven-day acceptance window have elapsed. Never derive these keys from OAuth credentials, and never log decrypted state, continuation tokens, credentials, receipts, or sensitive tool input.

## Exports

`mayiChannel`, `MayiEveConfigurationError`, `resolvePublicOrigin`, `MAYI_CALLBACK_PATH`, and the types `MayiChannelConfig`, `MayiChannelState`, `MayiReceiveTarget`, `MayiWebhookEventStore`, `MayiEnvironment`, `MayiEveConfigurationErrorCode`, and `ResolvePublicOriginOptions`.

## Answers beyond approvals

Only an approve/deny confirmation becomes a May I? **approval** (a binary, non-freeform confirmation whose two option ids are exactly `approve` and `deny`). Every other `ask_question` becomes a May I? **input**, which the same eligible person answers:

- **text** — a `text` ask, or any ask with no options, becomes a text input; the typed answer resumes the session.
- **confirmation** — a two-option, non-freeform confirmation whose ids aren't `approve`/`deny` (e.g. `yes`/`no`) stays a confirmation; the chosen option id resumes the session.
- **select** — anything else (more than two options, a `select` display, or a freeform confirmation) becomes a select. A freeform confirmation maps here so the human keeps a typed-answer path; the chosen option id, and any typed text, resume the session.

Every answered input carries a signed **answer attestation** — verifiable against Mayi's JWKS, the input analogue of an approval receipt — delivered and verified over the same callback path.

One residual behaviour: an **expired or cancelled** input has no safe synthetic answer, so the parked Eve session is not resumed. The adapter durably acknowledges the callback (HTTP `208`) to stop redelivery and the session stays parked — so give asks a lifetime the human can realistically meet.
