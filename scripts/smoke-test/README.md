# Deployment smoke test

`smoke.mjs` exercises the full product loop against a **deployed** instance —
by default production (`https://app.mayi.sh`):

1. An OAuth client is dynamically registered and runs the Authorization Code +
   PKCE flow (the same flow an MCP host runs to connect an agent).
2. A user signs up or signs in and consents on the consent screen.
3. The code is exchanged for an agent access token (this creates the agent).
4. The agent files an approval request through the real MCP surface
   (`POST /api/mcp`, `create_approval`).
5. The pending-approval email goes to the account's default notification
   channel; a human (or, in auto mode, the script) approves it.
6. The agent polls `get_approval` and must observe `APPROVED` plus a signed
   receipt.

It is a plain Node script (Node ≥ 20, no dependencies, no build step):

```bash
node scripts/smoke-test/smoke.mjs [--origin https://app.mayi.sh] [--auto]
```

Exit code 0 with `✔ SMOKE TEST PASSED` means the deployment serves the whole
loop. Any failed step prints `✘ SMOKE TEST FAILED: …` and exits 1.

## Auto mode — for agents and CI

```bash
node scripts/smoke-test/smoke.mjs --auto
```

Fully unattended: no browser, no mailbox. The script signs up a **fresh
throwaway account** (`mayi-smoke-<random>@example.com`, overridable with
`--email`), verifies signup created the born-verified default EMAIL forwarding
destination, drives the consent form and token exchange over HTTP with the
session token, files the approval, approves it through the owner decision
endpoint (standing in for the email deep link), and confirms the agent sees
`APPROVED` with a receipt.

What auto mode does NOT cover: actual email delivery (Postmark) and the deep
link inside the email. The pending-approval email is still queued and sent — to
the dummy address, where it bounces. If you run this often, pass `--email` with
an address on a domain you own. Use interactive mode when you want to verify
the mailbox leg itself.

Every `--auto` run leaves behind a throwaway user + workspace + agent + decided
approval on the target instance. That is acceptable noise for a smoke test;
there is currently no account deletion endpoint to clean up with.

## Interactive mode — full human loop

```bash
node scripts/smoke-test/smoke.mjs
```

Run this before/after production deployments when you want to see the real
thing: your browser opens the consent flow, the approval email lands in your
actual inbox, and you approve via its deep link while the script polls.

Interactive specifics:

- The client registers the RFC 8252 native-app redirect
  `http://127.0.0.1:8976/oauth-callback`; the script listens there and captures
  the authorization code automatically when the browser redirects after
  consent. Nothing to copy or paste, and the code never leaves the machine.
- The refresh token is saved to `~/.mayi/smoke-test-state.json` (per origin),
  so repeat runs skip the browser entirely. `--reset` forces a fresh
  registration + consent.
- The poll waits `--timeout-minutes` (default 15) for your decision. Denying
  the request, or letting it expire, fails the test on purpose.

## Notes for agents

- Prefer `--auto` unless the task is specifically about email delivery or the
  browser consent UX — those need a human and an inbox.
- Point `--origin` at any deployed environment; only use production when the
  task is about production.
- `--callback-uri` exists only because OAuth client registration requires a
  public-HTTPS approval callback URI. The smoke test never triggers callbacks;
  the default (an unused path on app.mayi.sh) is fine.
- Timing: an `--auto` run completes in a few seconds. An interactive run is
  bounded by how fast the human clicks.
