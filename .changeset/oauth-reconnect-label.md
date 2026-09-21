---
"@mayiapp/sdk": minor
---

OAuth connections can be reconnected and labelled. The authorize endpoint accepts `label` (names the installation on the consent screen and in the connections list) and `connection` (an existing `agent_id`; the code exchange renews that agent's credentials instead of creating a new agent, so its pending approvals stay readable). Token responses now include `agent_id`. An owner's revoke is recorded in `agents.revoked_by` and is final; a revoke caused by refresh-token reuse can be recovered by reconnecting.

`MayiClient.revokeAgent(id)` revokes a connection; the web app's Agents tab now offers it and shows revoked connections as revoked.
