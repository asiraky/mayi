# `@mayiapp/eve`

Durable Mayi approval and human-input channel for [Eve](https://github.com/vercel/eve) agents.

## Quick start

```sh
npm install @mayiapp/eve eve
```

Create the Mayi channel in the root agent:

```ts
// agent/channels/mayi.ts
import { mayiChannel } from "@mayiapp/eve";
import { credentials } from "../credentials.server";

export default mayiChannel({
  getAccessToken: () => credentials.getAccessToken("mayi"),
});
```

The host owns Mayi's Authorization Code + PKCE flow, securely stores and
refreshes the OAuth grant, and returns a current access token from
`getAccessToken`. The adapter and `@mayiapp/sdk` do not store tokens. Do not put an
access token, refresh token, static API key, or webhook endpoint ID in agent code.
Eden's generated integration supplies this credential binding; see the complete
[Eden agent template](https://github.com/asiraky/mayi/tree/main/packages/eve/examples/eden-agent).

An approval-gated tool remains ordinary Eve code:

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

## Approval evidence

Approval happens before Eve calls the gated tool's `execute()` function. An
evidence hook can render from the proposed tool input, fetch an existing object,
or read a file created by an earlier tool. It cannot use the gated tool's result,
because that result does not exist until after the human approves.

Configure `artefacts` when an approval should include a PDF or image:

```ts
export default mayiChannel({
  getAccessToken: () => credentials.getAccessToken("mayi"),
  async artefacts({ request, signal }) {
    const pdf = await renderDeploymentPlan(request.action.input, { signal });
    return [{
      filename: "deployment-plan.pdf",
      mediaType: "application/pdf",
      body: pdf,
    }];
  },
});
```

The hook receives the complete Eve input request, a read-only session snapshot,
`getSandbox()`, and an abort signal. For evidence already in object storage:

```ts
async artefacts({ request, signal }) {
  const response = await fetch(String(request.action.input.previewUrl), { signal });
  return [{ filename: "preview.webp", mediaType: "image/webp", body: response.body! }];
}
```

For a file produced by an earlier tool, read through Eve's supported sandbox
API and return the bytes:

```ts
async artefacts({ getSandbox }) {
  const sandbox = await getSandbox();
  const body = await sandbox.readBinaryFile("/workspace/output/report.pdf");
  return [{ filename: "report.pdf", mediaType: "application/pdf", body }];
}
```

`undefined`, `null`, and an empty array all mean no evidence and preserve the
ordinary one-call approval path. A request may return at most 20 artefacts;
each must be a PDF, PNG, JPEG, or WebP no larger than 25 MiB. Returned order is
the order shown to the approver and bound into the approval manifest. Hook,
validation, timeout, or upload failures fail closed: Mayi does not create an
approval with silently missing evidence. `artefactTimeoutMs` defaults to 30
seconds and its signal should be passed to rendering, fetch, and file work.

## Scheduled and cross-channel handoff

Mayi handles `input.requested` only for sessions owned by the Mayi channel. It
does not intercept a session that belongs to Slack, Discord, the default HTTP
channel, or another custom channel. Start work on Mayi with Eve's
`receive(mayi, ...)` whenever that work may need a Mayi approval.

Task-mode schedules cannot park for human input. Use the handler form of an Eve
schedule and hand the run to Mayi:

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

The same rule applies to cross-channel work. A custom channel route receives an
Eve `receive` helper; import the Mayi channel and hand the new session to it:

```ts
import { defineChannel, POST } from "eve/channels";
import mayi from "./mayi";

export default defineChannel({
  routes: [
    POST("/deploy-request", async (request, { receive, waitUntil }) => {
      const deployment = await request.json();
      waitUntil(receive(mayi, {
        message: `Review and deploy ${deployment.version}.`,
        target: { mayiUserId: deployment.approverId },
        auth: {
          authenticator: "eden",
          principalType: "service",
          principalId: deployment.requestedBy,
          attributes: {},
        },
      }));
      return new Response("accepted", { status: 202 });
    }),
  ],
});
```

`target.mayiUserId` is optional. When supplied, it must be a 12-letter Mayi user
ID and is sent as the suggested approver. The caller supplies the initial
message, target, and Eve authentication context; the adapter owns the raw
continuation token and durable channel state.

## Callback route and resume semantics

`mayiChannel()` registers this route in the deployed Eve service:

```text
POST /eve/v1/mayi/approval-resolved
```

Authors do not create that route, its URL, encrypted state, a correlation table,
or a signature verifier. The adapter builds the callback URL from the stable
public Eve origin. Register that exact HTTPS URL as an
entry in `approval_callback_uris` for the Eden/host OAuth client.

The explicit `POST()` route is intentional. Eve 0.24.2 compiles a channel
`route.path` verbatim; it does not prepend a channel namespace. Inventing a
`/channels/mayi/...` prefix registers the wrong OAuth callback and produces a
404 instead of a resume.

For every delivery, the adapter verifies Mayi's EdDSA JWS against Mayi's JWKS
before it touches encrypted state or resumes Eve. It then opens the authenticated
state and submits the response against the original Eve request ID and the
original channel-local continuation token. For an approval, an `approved`
result chooses Eve's `approve` option; `denied`, `expired`, and `cancelled`
choose `deny`, so the parked session resumes but the gated tool does not run.
For a generic input, an `answered` result resumes the session with the
respondent's option or text, while `expired` and `cancelled` are acknowledged
without resuming (see Supported ask shapes).

Callback delivery is at least once. A `2xx` response means Eve accepted the
resume or had already accepted the same verified event. The adapter does not
acknowledge before Eve accepts. Eve's continuation fence and event stream let
the adapter recognize an already-accepted resume, so retrying the same stable
event ID cannot execute the tool twice. Verification, decryption, or resume
failures return a non-`2xx` response so Mayi continues its durable retry policy.
The signed event and encrypted callback state remain acceptable for seven days
after resolution. Manual replay keeps the original event ID and occurrence time,
so operators must replay a dead letter within that window and consumers retain
the same duplicate-safety identity.

Hosts that already have a durable event store may pass `eventStore` with
`isProcessed(eventId)` and `markProcessed(eventId)` methods. The duplicate check
runs only after webhook verification, and `markProcessed` runs only after Eve
accepts the resume. A crash before acceptance therefore leaves the event
retryable. The hook is optional; ordinary Eden-generated integrations can rely
on Eve's durable acceptance check without adding a consumer database. The
advanced `webhookFetch` option can inject the fetch implementation used to load
Mayi's JWKS; normal deployments use the runtime's global `fetch`.

## Deployment configuration

The deployment host provisions:

- `EVE_PUBLIC_ORIGIN`: the stable public HTTPS base URL of the deployed Eve
  agent — an origin such as `https://agent.example`, or an origin plus a path
  prefix such as `https://eden.example/e/abc123def456` on hosts that route
  instances by path prefix on a shared hostname. Do not use a transient
  preview URL. On path-routed hosts the platform's ingress must strip the
  prefix before the request reaches the instance, because the adapter's
  registered callback route is always exactly `MAYI_CALLBACK_PATH`.
- `MAYI_CALLBACK_STATE_KEY_ID`: the identifier for the current callback-state
  encryption key.
- `MAYI_CALLBACK_STATE_KEY`: a stable base64url-encoded 32-byte encryption key.
- `MAYI_CALLBACK_STATE_PREVIOUS_KEYS` (optional): a JSON array of decrypt-only
  `{ "kid", "key" }` entries retained while approvals and callback retries made
  with older keys may still be outstanding.
- `MAYI_ORIGIN` (optional): the Mayi API and JWKS origin. It defaults to
  `https://app.mayi.sh`.

Keep callback-state keys stable across process restarts and deploys. Rotate by
installing a new current key and retaining the old key in
`MAYI_CALLBACK_STATE_PREVIOUS_KEYS` until its approvals and the seven-day
callback acceptance window have elapsed. Never derive these keys from OAuth
credentials.

For local development, pass a public HTTPS tunnel origin as `publicOrigin` to
`mayiChannel()`, and register the resulting callback URL on the development
OAuth client. This override is refused in production. Mayi signing keys are
read from `${MAYI_ORIGIN}/.well-known/jwks.json` and cached with bounded refresh;
they are not copied into the agent's environment.

Never log decrypted callback state, continuation tokens, OAuth credentials,
receipts, or sensitive tool input.

## Troubleshooting

- **Public base URL:** set `EVE_PUBLIC_ORIGIN` to one stable public HTTPS base
  URL (origin plus an optional path prefix for path-routed hosts). Vercel
  production can use `VERCEL_PROJECT_PRODUCTION_URL`; preview URLs, localhost,
  query strings, ports, and private hosts are refused.
- **Origin changes:** `approval_callback_uris` are immutable. Register a new
  OAuth client with the new callback, reconnect through Authorization Code +
  PKCE, confirm the new agent works, then revoke the old agent connection.
- **Local tunnels:** pass the tunnel origin through `publicOrigin` only in local
  development and register its exact callback on a development OAuth client.
  Tunnel rotation requires updating that development registration.
- **State rotation:** install a new callback-state key and retain old decrypt-only
  keys until every outstanding approval plus Mayi's seven-day acceptance window has
  elapsed. Unknown, tampered, expired, or wrong-key state fails closed.
- **Signing rotation:** Mayi publishes current and retained Ed25519 public keys at
  `/.well-known/jwks.json`. Keep old signing public keys available through the
  callback retry/event-age window; bounded JWKS refresh handles a newly seen key.
- **Retries and recovery:** non-`2xx` responses remain retryable according to
  Mayi's outbox policy. Inspect the Mayi callback job, correct the receiver, and
  replay only a `DEAD_LETTER` job through the authenticated replay endpoint. The
  stable event ID makes duplicate delivery safe.

## Supported ask shapes

Every Eve `ask_question` request routes to one of Mayi's two request APIs:

- An approve/deny confirmation — display `confirmation`, no freeform, exactly
  the `approve` and `deny` options — becomes a Mayi approval. This is the
  guarded-tool path: the human decision mints a signed receipt, and evidence
  from the `artefacts` hook is attached for the approver.
- Everything else becomes a generic Mayi input and resolves with a signed
  answer attestation instead of an approval receipt. A `text` ask maps to a
  text input. A `select` ask maps to a select input; option labels,
  descriptions, and styles map through, and `allowFreeform` passes through
  unchanged. A confirmation whose two options are not approve/deny maps to a
  confirmation input; a confirmation with any other option count, or with
  `allowFreeform`, maps to a select input so the freeform answer path survives
  (Mayi confirmations forbid freeform). A select or confirmation with no
  options is a freeform ask and maps to a text input. When the answer arrives,
  the adapter resumes the parked session with the respondent's chosen option
  or freeform text.

Artefact evidence is approval-only. Mayi's generic inputs API does not accept
artefacts, so the `artefacts` hook is not invoked for text, select, or
non-approval confirmation asks.

If an input expires or is cancelled before anyone answers, there is no safe
synthetic answer, so the adapter does not resume the session. It acknowledges
the callback so Mayi stops redelivering, and the session stays parked. Treat an
unanswered ask as an operational signal and monitor for parked sessions. This
differs from approvals, where `expired` and `cancelled` resolve to Eve's `deny`
option and the session resumes without running the gated tool.

The package is ESM-only, supports Node.js 24 and later (matching Eve), and pins
its Eve peer to the tested `eve@0.24.2` contract.

Licensed under the [Apache License 2.0](LICENSE).
