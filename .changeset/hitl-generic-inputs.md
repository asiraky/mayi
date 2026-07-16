---
"@mayiapp/sdk": minor
"@mayiapp/eve": minor
---

Generic human-in-the-loop inputs. The SDK gains `mayi.inputs.request` / `get` /
`list` / `cancel` for text, select, and confirmation asks, and the webhook
verifier now accepts `input.resolved` events alongside `approval.resolved`
(the result's `event` is now a union — narrow on `event.type`). The Eve adapter
maps every `ask_question` display type instead of rejecting non-approval asks:
approve/deny-shaped confirmations still go through the approvals API and mint
signed receipts; select, text, and other confirmations resolve through the new
inputs API with a signed answer attestation. `UnsupportedMayiInputError` is
removed from `@mayiapp/eve`. Expired or cancelled generic inputs acknowledge the
callback without resuming the Eve session.
