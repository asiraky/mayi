---
"@mayiapp/eve": patch
---

Republish after a release-pipeline failure: the publish job now builds the workspace before packing, so the package's declaration build can resolve `@mayiapp/sdk` types. No runtime changes.
