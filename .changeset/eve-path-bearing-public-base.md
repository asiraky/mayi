---
"@mayiapp/eve": minor
---

`EVE_PUBLIC_ORIGIN` (and the `publicOrigin` development override) now accepts a
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
