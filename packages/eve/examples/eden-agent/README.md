# Eden-hosted Eve agent

This template shows the complete author-facing Mayi handoff. Eden replaces the
credential placeholder with its generated integration, stores the OAuth refresh
grant, and supplies a current access token when `getAccessToken("mayi")` is
called. Do not put an access token or refresh token in this repository.

```text
agent/
  channels/mayi.ts
  credentials.server.ts
  schedules/check-production.ts
  tools/deploy-production.ts
```

The schedule deliberately uses its handler form and calls
`receive(mayi, ...)`. A markdown/task-mode schedule cannot park for a human
approval. Replace the deployment placeholder in `deploy-production.ts` with the
Eden-owned deployment integration used by your agent.
