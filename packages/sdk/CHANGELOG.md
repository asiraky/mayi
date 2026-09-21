# @mayiapp/sdk

## 0.4.0

### Minor Changes

- 35997db: OAuth connections can be reconnected and labelled. The authorize endpoint accepts `label` (names the installation on the consent screen and in the connections list) and `connection` (an existing `agent_id`; the code exchange renews that agent's credentials instead of creating a new agent, so its pending approvals stay readable). Token responses now include `agent_id`. An owner's revoke is recorded in `agents.revoked_by` and is final; a revoke caused by refresh-token reuse can be recovered by reconnecting.

  `MayiClient.revokeAgent(id)` revokes a connection; the web app's Agents tab now offers it and shows revoked connections as revoked.

- 72e1d7d: Approvals can carry human review content and form revision chains. `approvals.request` and `createApproval` accept optional `title`, `reviewMarkdown` and `supersedesApprovalId`. `Approval` responses add `title`, `reviewMarkdown`, `reviewDigest`, `supersedesApprovalId`, `supersededByApprovalId`, `decisionOutcome` and `reviewUrl`. Reviewers may decide `CHANGES_REQUESTED` with required feedback: the approval becomes `DENIED` (callback status `denied`, no receipt) and `decisionOutcome`/`decisionComment` carry the request. Approved receipts include a `review_digest` claim when present; the SDK exports `reviewDigest()` to recompute it.

## 0.3.0

### Minor Changes

- 3132f56: Add `passwordResetRequest` and `passwordResetConfirm` client methods for the new forgot-password flow (`POST /api/auth/password-reset/request` and `/confirm`).
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

## 0.2.0

### Minor Changes

- 711d2b8: Ship the public Mayi SDK and Eve approval channel with durable signed callback resume and request-bound PDF/image evidence support.
