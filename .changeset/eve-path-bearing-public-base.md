---
"@mayiapp/eve": minor
---

`EVE_PUBLIC_ORIGIN` (and the `publicOrigin` development override) now accepts a
path-bearing public HTTPS base URL, so hosts that route eve instances by path
prefix on a shared hostname — such as Eden's per-environment
`https://<eden-origin>/e/<envId>` ingress — can construct the approval-resolved
callback URL. The base is normalized by stripping trailing slashes and the
callback path is joined onto it. Every existing refusal is unchanged
(https-only, no credentials, no query or fragment, no port, public DNS
hostname, transient-preview refusal), root-origin behavior is byte-for-byte
identical, and the registered eve HTTP route remains `MAYI_CALLBACK_PATH` —
path-routed hosts must strip the prefix at their ingress.
