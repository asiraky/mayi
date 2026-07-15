import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  CALLBACK_ACCEPTANCE_WINDOW_SECONDS,
  MayiClient,
  MayiHttpError,
  createCallbackStateCodec,
  createWebhookVerifier,
  type Approval,
  type ApprovalRequest,
  type ApprovalResolvedEvent,
} from "../../packages/sdk/src/index.ts";
import { verifyExactReceipt } from "../../packages/receipts/src/index.ts";

const port = Number(process.env.PORT ?? 4400);
const mayiLocalOrigin = required("MAYI_LOCAL_ORIGIN");
const mayiPublicOrigin = required("MAYI_PUBLIC_ORIGIN");
const consumerPublicOrigin = required("CONSUMER_PUBLIC_ORIGIN");
const receiptAudience = required("RECEIPT_AUDIENCE");
const consumerApiKey = process.env.CONSUMER_API_KEY ?? "";
const controlSecret = required("CONTROL_SECRET");

type StoredRequest = {
  input: ApprovalRequest;
  idempotencyKey: string;
  approval: Approval;
};

type StoredEvent = {
  event: ApprovalResolvedEvent;
  decodedState: unknown;
  receiptValid: boolean | null;
  receiptClaims?: unknown;
};

const state = {
  clientId: "",
  codeVerifier: "",
  oauthState: "",
  authorizationCode: "",
  accessToken: "",
  refreshToken: "",
  events: [] as StoredEvent[],
  callbackErrors: [] as string[],
  requests: new Map<string, StoredRequest>(),
  consumableApprovals: new Map<string, string>(),
  processedEvents: new Set<string>(),
  lastCallback: undefined as { body: Uint8Array; signature: string } | undefined,
};

const codec = await createCallbackStateCodec({
  currentKey: { kid: "system-test-state", key: new Uint8Array(32).fill(73) },
  maximumRetryWindowSeconds: CALLBACK_ACCEPTANCE_WINDOW_SECONDS,
});
const verifier = createWebhookVerifier({
  mayiOrigin: mayiPublicOrigin,
  maximumEventAgeSeconds: CALLBACK_ACCEPTANCE_WINDOW_SECONDS,
  isProcessed: (eventId) => state.processedEvents.has(eventId),
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function body(request: IncomingMessage, maximum = 512 * 1024): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > maximum) throw new Error("request body too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await body(request);
  return bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> : {};
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function authorizedControlRequest(request: IncomingMessage): boolean {
  const supplied = request.headers.authorization;
  const expected = `Bearer ${controlSecret}`;
  if (typeof supplied !== "string" || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function client(): MayiClient {
  if (!state.accessToken) throw new Error("OAuth token has not been exchanged");
  return new MayiClient({
    origin: mayiLocalOrigin,
    dangerouslyAllowInsecureHttpForDevelopment: true,
    getAccessToken: async () => state.accessToken,
  });
}

async function register(): Promise<{ authorizeUrl: string; clientId: string }> {
  const registration = await fetch(`${mayiLocalOrigin}/api/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "PR36 exhaustive TypeScript consumer",
      redirect_uris: [`${consumerPublicOrigin}/oauth/callback`],
      approval_callback_uris: [`${consumerPublicOrigin}/mayi/callback`],
    }),
  });
  if (!registration.ok) throw new Error(`registration failed: ${registration.status} ${await registration.text()}`);
  const registered = await registration.json() as { client_id: string };
  state.clientId = registered.client_id;
  state.codeVerifier = base64Url(randomBytes(48));
  state.oauthState = randomUUID();
  const challenge = createHash("sha256").update(state.codeVerifier).digest("base64url");
  const url = new URL("/api/oauth/authorize", mayiLocalOrigin);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", state.clientId);
  url.searchParams.set("redirect_uri", `${consumerPublicOrigin}/oauth/callback`);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "approval:create approval:read approval:cancel");
  url.searchParams.set("state", state.oauthState);
  return { authorizeUrl: url.toString(), clientId: state.clientId };
}

async function exchange(): Promise<void> {
  if (!state.authorizationCode) throw new Error("authorization callback has not arrived");
  const response = await fetch(`${mayiLocalOrigin}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: state.authorizationCode,
      code_verifier: state.codeVerifier,
      client_id: state.clientId,
      redirect_uri: `${consumerPublicOrigin}/oauth/callback`,
    }),
  });
  if (!response.ok) throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
  const token = await response.json() as { access_token: string; refresh_token: string };
  state.accessToken = token.access_token;
  state.refreshToken = token.refresh_token;
}

function validPdf(label: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n% ${label}\n%%EOF\n`);
}

async function createApproval(input: Record<string, unknown>): Promise<Approval> {
  const scenario = String(input.scenario ?? randomUUID());
  const idempotencyKey = String(input.idempotencyKey ?? `system-${scenario}-${randomUUID()}`);
  const withArtefact = input.withArtefact === true;
  const expiresInSeconds = Number(input.expiresInSeconds ?? 900);
  const approvalExpiresAt = new Date(Date.now() + expiresInSeconds * 1_000).toISOString();
  const sealedState = await codec.seal({ scenario, nonce: randomUUID() }, { approvalExpiresAt });
  const sdk = client();
  const artefactIds: string[] = [];
  if (withArtefact) {
    const staged = await sdk.stageRequestArtefact(
      idempotencyKey,
      0,
      `${scenario}.pdf`,
      "application/pdf",
      validPdf(scenario),
    );
    artefactIds.push(staged.id);
  }
  const request: ApprovalRequest = {
    action: {
      kind: "tool-call",
      toolName: String(input.toolName ?? "deploy_release"),
      callId: `call-${scenario}`,
      input: { environment: "production", release: scenario, destructive: input.highRisk === true },
    },
    explanation: String(input.explanation ?? `System-test approval ${scenario}`),
    expiresInSeconds,
    callback: { url: `${consumerPublicOrigin}/mayi/callback`, state: sealedState },
    ...(artefactIds.length ? { artefactIds } : {}),
  };
  const approval = await sdk.approvals.request(request, { idempotencyKey });
  state.requests.set(scenario, { input: request, idempotencyKey, approval });
  return approval;
}

async function createConsumableApproval(scenario: string): Promise<Approval> {
  const sdk = client();
  const draft = await sdk.createApproval({
    action: {
      kind: "deploy.release",
      version: "1",
      audience: "production-deployer",
      resourceVersion: `current-${scenario}`,
      input: {
        environment: "production",
        releaseDigest: `sha256:${"a".repeat(64)}`,
        expectedCurrentRelease: `current-${scenario}`,
      },
    },
    explanation: `Consumable system-test approval ${scenario}`,
    expiresInSeconds: 900,
    enforcement: "consumed",
  }, `consumable-${scenario}`);
  const pending = await sdk.sealApproval(draft.id, []);
  state.consumableApprovals.set(scenario, pending.id);
  return pending;
}

async function consumeApproval(scenario: string): Promise<Record<string, number>> {
  if (!consumerApiKey) throw new Error("CONSUMER_API_KEY is unavailable");
  const approvalId = state.consumableApprovals.get(scenario);
  if (!approvalId) throw new Error("consumable scenario is unknown");
  const approval = await client().approval(approvalId);
  if (!approval.receipt) throw new Error("approved consumable request has no receipt");
  const request = (key: string, actionDigest: string) => fetch(`${mayiLocalOrigin}/api/receipts/consume`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-consumer-key": key },
    body: JSON.stringify({
      receipt: approval.receipt,
      actionDigest,
      manifestDigest: approval.manifestDigest,
    }),
  });
  const wrongKey = await request("wrong-consumer-key", approval.actionDigest!);
  const wrongDigest = await request(consumerApiKey, "0".repeat(64));
  const consumed = await request(consumerApiKey, approval.actionDigest!);
  const replay = await request(consumerApiKey, approval.actionDigest!);
  return {
    wrongConsumerKey: wrongKey.status,
    wrongActionDigest: wrongDigest.status,
    consumed: consumed.status,
    replay: replay.status,
  };
}

async function replayRequest(scenario: string): Promise<Approval> {
  const stored = state.requests.get(scenario);
  if (!stored) throw new Error("scenario is unknown");
  return client().approvals.request(stored.input, { idempotencyKey: stored.idempotencyKey });
}

async function idempotencyConflict(scenario: string): Promise<{ status: number; code?: string }> {
  const stored = state.requests.get(scenario);
  if (!stored) throw new Error("scenario is unknown");
  try {
    await client().approvals.request(
      { ...stored.input, explanation: `${stored.input.explanation} changed` },
      { idempotencyKey: stored.idempotencyKey },
    );
  } catch (error) {
    if (error instanceof MayiHttpError) return { status: error.status, ...(error.code ? { code: error.code } : {}) };
    throw error;
  }
  throw new Error("different idempotent content was accepted");
}

async function rawApiChecks(): Promise<Record<string, number | boolean>> {
  if (!state.accessToken) throw new Error("OAuth token has not been exchanged");
  const headers = { authorization: `Bearer ${state.accessToken}`, "content-type": "application/json" };
  const missingKey = await fetch(`${mayiLocalOrigin}/api/approvals/request`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  const malformedRequest = await fetch(`${mayiLocalOrigin}/api/approvals/request`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": `malformed-${randomUUID()}` },
    body: JSON.stringify({ action: { kind: "unknown" } }),
  });
  const mcpList = await fetch(`${mayiLocalOrigin}/api/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: "system-test", method: "tools/list", params: {} }),
  });
  const mcpBody = await mcpList.json() as { result?: { tools?: unknown[] } };
  const unauthorized = await fetch(`${mayiLocalOrigin}/api/approvals`);
  return {
    missingIdempotencyKey: missingKey.status,
    malformedRequest: malformedRequest.status,
    unauthorizedRead: unauthorized.status,
    mcpList: mcpList.status,
    mcpHasTools: Boolean(mcpBody.result?.tools?.length),
  };
}

async function rotateAndReuseRefreshToken(): Promise<Record<string, number | boolean>> {
  if (!state.refreshToken) throw new Error("refresh token is unavailable");
  const oldRefreshToken = state.refreshToken;
  const refresh = (refreshToken: string) => fetch(`${mayiLocalOrigin}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: state.clientId }),
  });
  const rotated = await refresh(oldRefreshToken);
  const rotatedBody = await rotated.json() as { access_token?: string; refresh_token?: string };
  if (!rotated.ok || !rotatedBody.access_token || !rotatedBody.refresh_token) {
    throw new Error(`refresh rotation failed with ${rotated.status}`);
  }
  state.accessToken = rotatedBody.access_token;
  state.refreshToken = rotatedBody.refresh_token;
  const reused = await refresh(oldRefreshToken);
  const accessAfterReuse = await fetch(`${mayiLocalOrigin}/api/approvals`, {
    headers: { authorization: `Bearer ${state.accessToken}` },
  });
  return {
    rotated: rotated.status,
    oldTokenReuse: reused.status,
    accessAfterReuse: accessAfterReuse.status,
    reuseRevokedFamily: accessAfterReuse.status === 401,
  };
}

async function handleCallback(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = await body(request, 128 * 1024);
  const signature = request.headers["x-mayi-signature"] as string | undefined;
  const result = await verifier.verify({
    body: raw,
    signature,
  });
  if (result.duplicate) {
    response.writeHead(208, { "cache-control": "no-store" });
    response.end();
    return;
  }
  const decodedState = await codec.open(result.event.state);
  let receiptValid: boolean | null = null;
  let receiptClaims: unknown;
  if (result.event.status === "approved") {
    if (!result.event.receipt) throw new Error("approved callback omitted receipt");
    const approval = await client().approval(result.event.approvalId);
    const jwksResponse = await fetch(`${mayiPublicOrigin}/.well-known/jwks.json`);
    if (!jwksResponse.ok) throw new Error("JWKS fetch failed during receipt verification");
    const jwks = await jwksResponse.json() as { keys: Array<Record<string, unknown>> };
    const header = JSON.parse(Buffer.from(result.event.receipt.split(".", 1)[0] ?? "", "base64url").toString()) as { kid?: unknown };
    const key = typeof header.kid === "string"
      ? jwks.keys.find((candidate) => candidate.kid === header.kid)
      : undefined;
    if (!key) throw new Error("JWKS does not contain the receipt signing key");
    receiptClaims = await verifyExactReceipt(result.event.receipt, key, {
      issuer: mayiPublicOrigin,
      audience: receiptAudience,
      action: approval.action,
      artefacts: approval.artefacts,
    });
    receiptValid = true;
  }
  state.processedEvents.add(result.event.id);
  if (!signature) throw new Error("verified callback omitted its signature header");
  state.lastCallback = { body: raw, signature };
  state.events.push({ event: result.event, decodedState, receiptValid, ...(receiptClaims ? { receiptClaims } : {}) });
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith("/control/") && !authorizedControlRequest(request)) {
    return sendJson(response, 401, { error: "control authorization required" });
  }
  if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { ok: true });
  if (request.method === "GET" && url.pathname === "/oauth/callback") {
    if (url.searchParams.get("state") !== state.oauthState) return sendJson(response, 400, { error: "oauth state mismatch" });
    const code = url.searchParams.get("code");
    if (!code) return sendJson(response, 400, { error: url.searchParams.get("error") ?? "authorization code missing" });
    state.authorizationCode = code;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>Consumer connected</title><h1>Consumer connected</h1><p>You can return to the test runner.</p>");
    return;
  }
  if (request.method === "POST" && url.pathname === "/mayi/callback") return handleCallback(request, response);
  if (request.method === "POST" && url.pathname === "/control/register") return sendJson(response, 200, await register());
  if (request.method === "POST" && url.pathname === "/control/exchange") {
    await exchange();
    return sendJson(response, 200, { connected: true });
  }
  if (request.method === "POST" && url.pathname === "/control/request") return sendJson(response, 200, await createApproval(await jsonBody(request)));
  if (request.method === "POST" && url.pathname === "/control/request-consumable") {
    const input = await jsonBody(request);
    return sendJson(response, 200, await createConsumableApproval(String(input.scenario ?? randomUUID())));
  }
  if (request.method === "POST" && url.pathname === "/control/consume") {
    const input = await jsonBody(request);
    return sendJson(response, 200, await consumeApproval(String(input.scenario ?? "")));
  }
  if (request.method === "POST" && url.pathname === "/control/replay-request") {
    const input = await jsonBody(request);
    return sendJson(response, 200, await replayRequest(String(input.scenario ?? "")));
  }
  if (request.method === "POST" && url.pathname === "/control/idempotency-conflict") {
    const input = await jsonBody(request);
    return sendJson(response, 200, await idempotencyConflict(String(input.scenario ?? "")));
  }
  if (request.method === "POST" && url.pathname === "/control/raw-api-checks") {
    return sendJson(response, 200, await rawApiChecks());
  }
  if (request.method === "POST" && url.pathname === "/control/redeliver-last-callback") {
    if (!state.lastCallback) throw new Error("no successful callback is available");
    const duplicate = await fetch(`http://127.0.0.1:${port}/mayi/callback`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mayi-signature": state.lastCallback.signature },
      body: state.lastCallback.body as unknown as BodyInit,
    });
    return sendJson(response, 200, { status: duplicate.status, duplicate: duplicate.status === 208 });
  }
  if (request.method === "POST" && url.pathname === "/control/refresh-rotation") {
    return sendJson(response, 200, await rotateAndReuseRefreshToken());
  }
  if (request.method === "POST" && url.pathname === "/control/cancel") {
    const input = await jsonBody(request);
    return sendJson(response, 200, await client().cancel(String(input.approvalId ?? "")));
  }
  if (request.method === "GET" && url.pathname === "/control/approval") {
    return sendJson(response, 200, await client().approval(String(url.searchParams.get("id") ?? "")));
  }
  if (request.method === "GET" && url.pathname === "/control/status") {
    return sendJson(response, 200, {
      registered: Boolean(state.clientId),
      authorized: Boolean(state.authorizationCode),
      connected: Boolean(state.accessToken),
      events: state.events,
      callbackErrors: state.callbackErrors,
      scenarios: [...state.requests].map(([scenario, stored]) => ({ scenario, approvalId: stored.approval.id })),
    });
  }
  sendJson(response, 404, { error: "not found" });
}

const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    const message = error instanceof Error ? error.message : "unknown consumer error";
    if (request.url?.startsWith("/mayi/callback")) state.callbackErrors.push(message);
    if (!response.headersSent) sendJson(response, 500, { error: message });
    else response.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Fake TypeScript consumer listening on http://127.0.0.1:${port}`);
});
