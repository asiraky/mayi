---
---

CI workflow only: restrict the `push` trigger to `main` so pushes to PR branches no longer run CI twice (once for `push`, once for `pull_request`). No package changes.
