# @mayiapp/eve

## 0.3.0

### Minor Changes

- 48c2b9c: `EVE_PUBLIC_ORIGIN` (and the `publicOrigin` development override) now accepts a
  path-bearing public HTTPS base URL, so hosts that route eve instances by path
  prefix on a shared hostname — such as Eden's per-environment
  `https://<eden-origin>/e/<envId>` ingress — can construct the approval-resolved
  callback URL. The base is normalized by stripping trailing slashes and the
  callback path is joined onto it. Every existing refusal is kept (https-only,
  no credentials, no query or fragment, no non-default port, public DNS
  hostname, transient-preview refusal), and two are added fail-closed: hostnames
  with a trailing DNS dot and bases too long to yield a registrable 2048-char
  callback URL. Root-origin behavior is otherwise byte-for-byte identical, the
  Vercel production fallback stays origin-only, and the registered eve HTTP
  route remains `MAYI_CALLBACK_PATH` — path-routed hosts must strip the prefix
  at their ingress.
- 37660d3: Generic human-in-the-loop inputs. The SDK gains `mayi.inputs.request` / `get` /
  `list` / `cancel` for text, select, and confirmation asks, and the webhook
  verifier now accepts `input.resolved` events alongside `approval.resolved`
  (the result's `event` is now a union — narrow on `event.type`). The Eve adapter
  maps every `ask_question` display type instead of rejecting non-approval asks:
  approve/deny-shaped confirmations still go through the approvals API and mint
  signed receipts; select, text, and other confirmations resolve through the new
  inputs API with a signed answer attestation. `UnsupportedMayiInputError` is
  removed from `@mayiapp/eve`. Expired or cancelled generic inputs acknowledge the
  callback without resuming the Eve session.

### Patch Changes

- Updated dependencies [3132f56]
- Updated dependencies [37660d3]
  - @mayiapp/sdk@0.3.0

## 0.2.1

### Patch Changes

- 655214e: Republish after a release-pipeline failure: the publish job now builds the workspace before packing, so the package's declaration build can resolve `@mayiapp/sdk` types. No runtime changes.

## 0.2.0

### Minor Changes

- 711d2b8: Ship the public Mayi SDK and Eve approval channel with durable signed callback resume and request-bound PDF/image evidence support.

### Patch Changes

- Updated dependencies [711d2b8]
  - @mayiapp/sdk@0.2.0
