---
---

Tooling only: `pnpm deploy:site` now runs a preflight that refuses to publish to production unless on `main`, with a clean tree, in sync with `origin/main`. No package changes.
