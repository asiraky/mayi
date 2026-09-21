---
"@mayiapp/sdk": minor
---

Approvals can carry human review content and form revision chains. `approvals.request` and `createApproval` accept optional `title`, `reviewMarkdown` and `supersedesApprovalId`. `Approval` responses add `title`, `reviewMarkdown`, `reviewDigest`, `supersedesApprovalId`, `supersededByApprovalId`, `decisionOutcome` and `reviewUrl`. Reviewers may decide `CHANGES_REQUESTED` with required feedback: the approval becomes `DENIED` (callback status `denied`, no receipt) and `decisionOutcome`/`decisionComment` carry the request. Approved receipts include a `review_digest` claim when present; the SDK exports `reviewDigest()` to recompute it.
