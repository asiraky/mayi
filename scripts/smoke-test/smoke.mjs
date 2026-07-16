#!/usr/bin/env node
// End-to-end smoke test for a deployed May I? instance. See README.md next to
// this file for the full walkthrough. Zero dependencies; requires Node >= 20.
//
//   node scripts/smoke-test/smoke.mjs                  interactive, https://app.mayi.sh
//   node scripts/smoke-test/smoke.mjs --auto           unattended, fresh dummy account
//   node scripts/smoke-test/smoke.mjs --origin http://localhost:3000 [--auto]
//
// Interactive mode exercises the real human path: browser sign-up/sign-in and
// consent, then the approval email's deep link. Auto mode signs up a throwaway
// account and drives the same server endpoints (consent form post, decision
// endpoint) directly, so it needs no browser and no mailbox.

/* global console, fetch, Buffer */
import { createHash, createPublicKey, randomBytes, randomUUID, verify as cryptoVerify } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import process from "node:process";

const SCOPES = "approval:create approval:read approval:cancel";
const STATE_DIR = join(homedir(), ".mayi");
const STATE_FILE = join(STATE_DIR, "smoke-test-state.json");
const LOOPBACK_PORT = 8976;

function parseArgs(argv) {
  const options = {
    origin: "https://app.mayi.sh",
    auto: false,
    reset: false,
    timeoutMinutes: 15,
    callbackUri: "https://app.mayi.sh/mayi-smoke/unused-callback",
    email: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--auto") options.auto = true;
    else if (argument === "--reset") options.reset = true;
    else if (argument === "--origin") options.origin = argv[++index] ?? "";
    else if (argument === "--timeout-minutes") options.timeoutMinutes = Number(argv[++index]);
    else if (argument === "--callback-uri") options.callbackUri = argv[++index] ?? "";
    else if (argument === "--email") options.email = argv[++index] ?? "";
    else if (argument === "--help" || argument === "-h") {
      console.log(`Usage: node scripts/smoke-test/smoke.mjs [options]

Options:
  --origin <url>            Deployment to test (default https://app.mayi.sh)
  --auto                    Unattended run: fresh dummy account, no browser, no mailbox
  --email <address>         Auto mode signup address (default mayi-smoke-<id>@example.com)
  --reset                   Interactive mode: forget the saved connection for this origin
  --timeout-minutes <n>     Interactive mode: how long to wait for the email decision (default 15)
  --callback-uri <url>      approval_callback_uris value for client registration; never
                            invoked by this test, but registration requires a public
                            HTTPS URL (default https://app.mayi.sh/mayi-smoke/unused-callback)
`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${argument}`);
      process.exit(2);
    }
  }
  options.origin = options.origin.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(options.origin)) {
    console.error(`--origin must be an http(s) URL, got "${options.origin}"`);
    process.exit(2);
  }
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes < 1) {
    console.error("--timeout-minutes must be a number >= 1");
    process.exit(2);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
let stepNumber = 0;

function step(title) {
  stepNumber += 1;
  console.log(`\n[${stepNumber}] ${title}`);
}

function ok(message) {
  console.log(`    ✔ ${message}`);
}

function info(message) {
  console.log(`    · ${message}`);
}

function fail(message) {
  console.error(`\n✘ SMOKE TEST FAILED: ${message}`);
  process.exit(1);
}

async function api(path, init = {}) {
  const url = `${options.origin}${path}`;
  let response;
  try {
    response = await fetch(url, { redirect: "manual", ...init });
  } catch (error) {
    fail(`${init.method ?? "GET"} ${url} did not connect: ${error?.cause?.message ?? error.message}`);
  }
  return response;
}

async function apiJson(path, init = {}, expected = 200) {
  const response = await api(path, init);
  const text = await response.text();
  if (response.status !== expected) {
    fail(`${init.method ?? "GET"} ${path} returned ${response.status} (expected ${expected}): ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${init.method ?? "GET"} ${path} returned non-JSON body: ${text.slice(0, 200)}`);
  }
}

function json(body) {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function openBrowser(url) {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const commandArguments = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, commandArguments, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// The RFC 8252 loopback redirect: the browser delivers the authorization code
// straight to this process, and it never leaves the machine.
const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/oauth-callback`;

async function registerClient() {
  const redirectUri = REDIRECT_URI;
  const registration = await apiJson("/api/oauth/register", {
    method: "POST",
    ...json({
      client_name: "May I? smoke test",
      redirect_uris: [redirectUri],
      approval_callback_uris: [options.callbackUri],
    }),
  });
  ok(`registered OAuth client ${registration.client_id}`);
  return { clientId: registration.client_id, redirectUri };
}

function authorizeUrl(client, challenge, oauthState) {
  const url = new URL("/api/oauth/authorize", options.origin);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", oauthState);
  return url.toString();
}

function extractCode(redirectedUrl, expectedState) {
  let url;
  try {
    url = new URL(redirectedUrl.trim());
  } catch {
    return { error: "that is not a URL" };
  }
  const error = url.searchParams.get("error");
  if (error) return { error: `authorization was refused: ${error}` };
  const code = url.searchParams.get("code");
  if (!code) return { error: "the URL has no ?code= parameter" };
  if (url.searchParams.get("state") !== expectedState) return { error: "state parameter mismatch (stale or foreign URL)" };
  return { code };
}

async function waitForLoopbackCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${LOOPBACK_PORT}`);
      if (url.pathname !== "/oauth-callback") {
        response.writeHead(404).end();
        return;
      }
      const result = extractCode(url.toString(), expectedState);
      if (result.error) {
        response.writeHead(400, { "content-type": "text/plain" }).end(`Smoke test: ${result.error}`);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Smoke test</title><h1>Connected</h1><p>You can close this tab and return to the terminal.</p>");
      server.close();
      resolve(result.code);
    });
    server.on("error", reject);
    server.listen(LOOPBACK_PORT, "127.0.0.1");
  });
}

async function exchangeCode(client, code, verifier) {
  const token = await apiJson("/api/oauth/token", {
    method: "POST",
    ...json({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
    }),
  });
  return token;
}

async function refreshAccessToken(saved) {
  const response = await api("/api/oauth/token", {
    method: "POST",
    ...json({ grant_type: "refresh_token", refresh_token: saved.refreshToken, client_id: saved.clientId }),
  });
  if (!response.ok) return null;
  return response.json();
}

async function mcp(accessToken, method, params) {
  const body = await apiJson("/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  if (body.error) fail(`MCP ${method} returned an error: ${JSON.stringify(body.error)}`);
  if (body.result?.isError) fail(`MCP ${method} tool error: ${JSON.stringify(body.result.content)}`);
  return body.result;
}

async function createApproval(accessToken, explanation) {
  const callId = `smoke-${randomUUID()}`;
  const result = await mcp(accessToken, "tools/call", {
    name: "create_approval",
    arguments: {
      action: {
        kind: "tool-call",
        toolName: "smoke_test",
        callId,
        input: { origin: options.origin, mode: options.auto ? "auto" : "interactive" },
      },
      explanation,
      expiresInSeconds: 1800,
      enforcement: "cooperative",
      idempotencyKey: callId,
    },
  });
  const approval = result.structuredContent;
  if (!approval?.id || approval.state !== "PENDING") {
    fail(`create_approval did not return a PENDING approval: ${JSON.stringify(approval).slice(0, 300)}`);
  }
  return approval;
}

async function getApproval(accessToken, id) {
  const result = await mcp(accessToken, "tools/call", { name: "get_approval", arguments: { id } });
  return result.structuredContent;
}

async function pollUntilDecided(accessToken, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastNotice = 0;
  for (;;) {
    const approval = await getApproval(accessToken, id);
    if (!approval) fail("get_approval no longer sees the approval (wrong agent or workspace?)");
    if (approval.state !== "PENDING") return approval;
    if (Date.now() >= deadline) return approval;
    if (Date.now() - lastNotice > 60_000) {
      info(`still PENDING, waiting… (${Math.round((deadline - Date.now()) / 60_000)} min left)`);
      lastNotice = Date.now();
    }
    await delay(5_000);
  }
}

// ── Human-in-the-loop inputs (text / select / confirmation) ──────────────────
// The inputs feature is a REST + SDK resource, not an MCP tool: agents call
// POST /api/inputs with their bearer token; an owner/approver answers through
// POST /api/inputs/:id/answer (the app screen, or the email deep link). This
// mirrors the approval leg but resolves with a signed *answer attestation*
// instead of a receipt, which we verify against the published JWKS below.

async function requestInput(accessToken, body) {
  const response = await api("/api/inputs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== 200) fail(`POST /api/inputs (${body.type}) returned ${response.status}: ${text.slice(0, 400)}`);
  const input = JSON.parse(text);
  if (input.state !== "PENDING") fail(`requested ${body.type} input is ${input.state}, expected PENDING`);
  return input;
}

async function getInputAsAgent(accessToken, id) {
  return apiJson(`/api/inputs/${id}`, { headers: { authorization: `Bearer ${accessToken}` } });
}

async function answerInput(session, id, answer) {
  return apiJson(`/api/inputs/${id}/answer`, {
    method: "POST",
    headers: { ...session, "content-type": "application/json" },
    body: JSON.stringify(answer),
  });
}

async function cancelInput(accessToken, id) {
  return apiJson(`/api/inputs/${id}/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  });
}

function decodeJwtSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

// Verify the EdDSA answer attestation against the server's published JWKS,
// zero-dependency: this is the crypto leg the whole product rests on, so the
// smoke test proves an answer is cryptographically bound to the input, the
// respondent, and the answer digest — not merely that a string was stored.
async function verifyAttestation(attestation, { inputId, respondentId, expectedAnswer }) {
  const parts = attestation.split(".");
  if (parts.length !== 3) fail("attestation is not a compact JWS (expected three segments)");
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = decodeJwtSegment(headerSegment);
  if (header.alg !== "EdDSA") fail(`attestation alg is ${header.alg}, expected EdDSA`);

  const jwks = await apiJson("/.well-known/jwks.json");
  const jwk = jwks.keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk) fail(`attestation kid ${header.kid} is not published in JWKS`);

  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const signingInput = Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii");
  const signature = Buffer.from(signatureSegment, "base64url");
  if (!cryptoVerify(null, signingInput, publicKey, signature)) {
    fail("attestation signature failed EdDSA verification against the published JWKS");
  }

  const claims = decodeJwtSegment(payloadSegment);
  if (claims.sub !== inputId) fail(`attestation sub ${claims.sub} != input ${inputId}`);
  if (claims.respondent_id !== respondentId) fail(`attestation respondent_id ${claims.respondent_id} != ${respondentId}`);
  if (JSON.stringify(claims.answer) !== JSON.stringify(expectedAnswer)) {
    fail(`attestation answer ${JSON.stringify(claims.answer)} != ${JSON.stringify(expectedAnswer)}`);
  }
  if (typeof claims.answer_digest !== "string" || !claims.answer_digest) fail("attestation is missing an answer_digest");
  if ("exp" in claims) fail("answer attestation must not carry an exp claim (it is durable provenance, not an enforceable grant)");
  return claims;
}

// Drive one input type through request → answer → agent-observes-ANSWERED, and
// verify the resolved attestation cryptographically. Returns nothing; fails hard.
async function exerciseInput(session, accessToken, ownerUserId, { label, request, answer, expectedAnswer }) {
  const input = await requestInput(accessToken, request);
  info(`${label}: input ${input.id} PENDING`);
  const answered = await answerInput(session, input.id, answer);
  if (answered.state !== "ANSWERED") fail(`${label}: answer left input ${answered.state}, expected ANSWERED`);
  if (answered.respondentId !== ownerUserId) fail(`${label}: respondentId ${answered.respondentId} != owner ${ownerUserId}`);
  const observed = await getInputAsAgent(accessToken, input.id);
  if (observed.state !== "ANSWERED") fail(`${label}: agent sees ${observed.state}, expected ANSWERED`);
  if (!observed.attestation) fail(`${label}: answered input has no attestation`);
  if (JSON.stringify(observed.answer) !== JSON.stringify(expectedAnswer)) {
    fail(`${label}: agent sees answer ${JSON.stringify(observed.answer)} != ${JSON.stringify(expectedAnswer)}`);
  }
  await verifyAttestation(observed.attestation, { inputId: input.id, respondentId: ownerUserId, expectedAnswer });
  ok(`${label}: ANSWERED, attestation verified against JWKS`);
  return input;
}

async function runInputsLeg(session, accessToken, ownerUserId) {
  step("Exercising human-in-the-loop inputs (text / select / confirmation)");

  await exerciseInput(session, accessToken, ownerUserId, {
    label: "text",
    request: { type: "text", prompt: "Smoke test: what should the deploy note say?", expiresInSeconds: 1800 },
    answer: { text: "Ship it — smoke test answer." },
    expectedAnswer: { text: "Ship it — smoke test answer." },
  });

  await exerciseInput(session, accessToken, ownerUserId, {
    label: "select",
    request: {
      type: "select",
      prompt: "Smoke test: which environment?",
      options: [
        { id: "staging", label: "Staging" },
        { id: "prod", label: "Production", style: "danger" },
      ],
      expiresInSeconds: 1800,
    },
    answer: { optionId: "staging" },
    expectedAnswer: { optionId: "staging" },
  });

  await exerciseInput(session, accessToken, ownerUserId, {
    label: "confirmation",
    request: {
      type: "confirmation",
      prompt: "Smoke test: proceed with the irreversible action?",
      options: [
        { id: "yes", label: "Yes, proceed", style: "danger" },
        { id: "no", label: "No, stop" },
      ],
      expiresInSeconds: 1800,
    },
    answer: { optionId: "yes" },
    expectedAnswer: { optionId: "yes" },
  });

  // Cancel leg: the agent withdraws a still-pending ask; the owner must then be
  // unable to answer it, and the agent must observe CANCELLED.
  const toCancel = await requestInput(accessToken, {
    type: "text",
    prompt: "Smoke test: this ask will be cancelled by the agent.",
    expiresInSeconds: 1800,
  });
  const cancelled = await cancelInput(accessToken, toCancel.id);
  if (cancelled.state !== "CANCELLED") fail(`cancel left input ${cancelled.state}, expected CANCELLED`);
  const lateAnswer = await api(`/api/inputs/${toCancel.id}/answer`, {
    method: "POST",
    headers: { ...session, "content-type": "application/json" },
    body: JSON.stringify({ text: "too late" }),
  });
  if (lateAnswer.status !== 409) fail(`answering a cancelled input returned ${lateAnswer.status}, expected 409`);
  ok(`cancel: input ${toCancel.id} CANCELLED, late answer correctly rejected (409)`);

  // Confidentiality guard (codex finding): a generic input must not fan out to
  // every verified destination — only match-all EMAIL forwarding rules. Confirm
  // the agent's own list surface sees exactly the inputs we created.
  const listed = await apiJson("/api/inputs", { headers: { authorization: `Bearer ${accessToken}` } });
  const answeredCount = listed.filter((entry) => entry.state === "ANSWERED").length;
  const cancelledCount = listed.filter((entry) => entry.state === "CANCELLED").length;
  if (answeredCount < 3) fail(`agent input list shows ${answeredCount} ANSWERED, expected >= 3`);
  if (cancelledCount < 1) fail(`agent input list shows ${cancelledCount} CANCELLED, expected >= 1`);
  ok(`agent list surface reports ${answeredCount} answered + ${cancelledCount} cancelled input(s)`);
}

function summary(lines) {
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`✔ SMOKE TEST PASSED (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  for (const line of lines) console.log(`  • ${line}`);
}

async function checkReady() {
  step(`Checking ${options.origin} is up`);
  const response = await api("/api/ready");
  if (response.status !== 200) fail(`GET /api/ready returned ${response.status}`);
  ok("service is ready");
}

// ── Interactive mode ─────────────────────────────────────────────────────────

async function interactive() {
  await checkReady();

  step("Connecting as an agent (OAuth PKCE)");
  const state = await loadState();
  let saved = options.reset ? undefined : state[options.origin];
  let token;
  let client;

  if (saved?.refreshToken) {
    token = await refreshAccessToken(saved);
    if (token) {
      ok("reused saved connection via refresh token (pass --reset to force the browser flow)");
      client = { clientId: saved.clientId, redirectUri: saved.redirectUri };
    } else {
      info("saved refresh token was rejected; starting a fresh browser flow");
      saved = undefined;
    }
  }

  if (!token) {
    client = saved?.clientId && saved.redirectUri === REDIRECT_URI
      ? { clientId: saved.clientId, redirectUri: saved.redirectUri }
      : await registerClient();
    const { verifier, challenge } = pkcePair();
    const oauthState = randomUUID();
    const url = authorizeUrl(client, challenge, oauthState);
    const codeArrived = waitForLoopbackCode(oauthState);
    console.log("\n    Opening your browser. Sign up (or sign in), then press Allow on the consent screen.");
    console.log("    The code is captured automatically when the browser redirects back here.");
    console.log(`\n    ${url}\n`);
    if (!openBrowser(url)) info("could not launch a browser automatically; open the URL above manually");
    const code = await codeArrived;
    ok("authorization code captured on the loopback redirect");
    token = await exchangeCode(client, code, verifier);
    ok("exchanged code for an access token");
  }

  state[options.origin] = {
    clientId: client.clientId,
    redirectUri: client.redirectUri,
    refreshToken: token.refresh_token,
    savedAt: new Date().toISOString(),
  };
  await saveState(state);
  info(`connection saved to ${STATE_FILE}`);

  step("Creating an approval request through the MCP surface");
  const approval = await createApproval(
    token.access_token,
    "Smoke test: approve this request from the email notification (or the app) to complete the end-to-end test.",
  );
  ok(`approval ${approval.id} is PENDING`);

  step("Waiting for your decision");
  console.log("\n    ➜ Check the inbox of the account you signed in with — a May I? approval email");
  console.log("      should arrive shortly. Follow its link and approve the request.");
  console.log(`      (Fallback if no email arrives: ${options.origin} lists the pending request.)\n`);
  const decided = await pollUntilDecided(token.access_token, approval.id, options.timeoutMinutes * 60_000);
  if (decided.state === "PENDING") {
    fail(`approval ${approval.id} was still PENDING after ${options.timeoutMinutes} minutes. If the email never arrived, that is the failure to investigate.`);
  }
  if (decided.state !== "APPROVED") {
    fail(`approval ${approval.id} ended ${decided.state}, expected APPROVED`);
  }
  ok(`approval was APPROVED by ${decided.approverId} at ${decided.decidedAt}`);
  if (!decided.receipt) fail("approved approval has no receipt");
  ok("decision receipt is present");

  summary([
    `origin: ${options.origin}`,
    `OAuth client: ${client.clientId}`,
    `approval: ${approval.id} → APPROVED (via email deep link)`,
    "receipt issued",
  ]);
}

// ── Auto mode ────────────────────────────────────────────────────────────────

async function auto() {
  await checkReady();

  const email = options.email || `mayi-smoke-${randomBytes(6).toString("hex")}@example.com`;
  const password = `Smoke-${randomBytes(9).toString("base64url")}9!`;

  step(`Signing up a fresh account (${email})`);
  const signup = await apiJson("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-mayi-native": "true" },
    body: JSON.stringify({ email, displayName: "Smoke Test", password }),
  });
  if (!signup.sessionToken) fail("signup did not return a session token");
  const session = { authorization: `Bearer ${signup.sessionToken}` };
  ok(`workspace ${signup.workspace.id} created for user ${signup.user.id}`);

  step("Verifying the default email notification channel exists");
  const destinations = await apiJson("/api/forwarding/destinations", { headers: session });
  const defaultChannel = destinations.find(
    (destination) => destination.type === "EMAIL" && destination.endpoint === email.toLowerCase(),
  );
  if (!defaultChannel) fail(`signup did not create an EMAIL forwarding destination for ${email}`);
  if (!defaultChannel.verified_at) fail("default email destination is not born-verified");
  ok(`destination ${defaultChannel.id} exists, verified, mode ${defaultChannel.mode}`);

  step("Registering an OAuth client and requesting consent");
  const client = await registerClient();
  const { verifier, challenge } = pkcePair();
  const oauthState = randomUUID();
  const authorize = new URL(authorizeUrl(client, challenge, oauthState));
  const consentScreen = await api(`${authorize.pathname}${authorize.search}`, { headers: session });
  const consentHtml = await consentScreen.text();
  if (consentScreen.status !== 200 || !consentHtml.includes("May I? smoke test")) {
    fail(`consent screen did not render (status ${consentScreen.status})`);
  }
  ok("consent screen renders for the signed-in user");
  const consent = await api("/api/oauth/consent", {
    method: "POST",
    headers: { ...session, "content-type": "application/json" },
    body: JSON.stringify({
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      code_challenge: challenge,
      scope: SCOPES,
      state: oauthState,
      decision: "approve",
    }),
  });
  const location = consent.headers.get("location");
  if (!(consent.status === 302 || consent.status === 301) || !location) {
    fail(`consent did not redirect (status ${consent.status})`);
  }
  const extracted = extractCode(location, oauthState);
  if (extracted.error) fail(`consent redirect is unusable: ${extracted.error}`);
  ok("consent granted, authorization code issued");

  step("Exchanging the code for an agent token");
  const token = await exchangeCode(client, extracted.code, verifier);
  ok("agent access token issued");

  step("Creating an approval request through the MCP surface");
  const approval = await createApproval(token.access_token, "Automated smoke test approval.");
  ok(`approval ${approval.id} is PENDING (email job queued for ${email})`);

  step("Approving as the account owner (in place of the email deep link)");
  const decided = await apiJson(`/api/approvals/${approval.id}/decision`, {
    method: "POST",
    headers: { ...session, "content-type": "application/json" },
    body: JSON.stringify({ decision: "APPROVED", comment: "smoke test auto-approval" }),
  });
  if (decided.state !== "APPROVED") fail(`decision endpoint returned state ${decided.state}`);
  ok("owner decision accepted");

  step("Confirming the agent observes the decision");
  const observed = await getApproval(token.access_token, approval.id);
  if (observed?.state !== "APPROVED") fail(`agent sees state ${observed?.state}, expected APPROVED`);
  if (!observed.receipt) fail("approved approval has no receipt");
  ok("agent sees APPROVED with a signed receipt");

  await runInputsLeg(session, token.access_token, signup.user.id);

  summary([
    `origin: ${options.origin}`,
    `throwaway account: ${email} (workspace ${signup.workspace.id})`,
    `default email channel: ${defaultChannel.id} (born verified)`,
    `approval: ${approval.id} → APPROVED, receipt issued`,
    "inputs: text + select + confirmation → ANSWERED, attestations verified against JWKS",
    "inputs: cancel path CANCELLED, late answer rejected (409)",
    "note: the pending-approval email was queued to the dummy address and will bounce; pass --email for a real inbox",
  ]);
}

await (options.auto ? auto() : interactive());
