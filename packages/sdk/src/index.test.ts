import type { ApprovalRequest, CreateApproval, InputRequest } from "@mayi/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  MayiAuthenticationError,
  MayiClient,
  MayiConfigurationError,
  MayiHttpError,
  MayiNetworkError,
  MayiResponseError,
  type MayiFetch,
} from "./index";

const requestInput: ApprovalRequest = {
  action: {
    kind: "tool-call",
    toolName: "deploy_release",
    callId: "call-42",
    input: { environment: "production", releaseDigest: "sha256:abc" },
  },
  explanation: "Deploy the release that passed CI.",
  suggestedApproverId: "ApproverAbcd",
  expiresInSeconds: 900,
  callback: { url: "https://agent.example/callback", state: "opaque-secret-state" },
};

const pendingApproval = {
  id: "ApprovalAbcd",
  workspaceId: "WorkspaceAbc",
  agentId: "AgentAbcdefg",
  state: "PENDING" as const,
  action: requestInput.action,
  explanation: requestInput.explanation,
  enforcement: "cooperative" as const,
  actionDigest: "a".repeat(64),
  manifestDigest: "b".repeat(64),
  artefacts: [],
  createdAt: "2026-07-15T00:00:00.000Z",
  sealedAt: "2026-07-15T00:00:01.000Z",
  expiresAt: "2026-07-15T00:15:00.000Z",
  decidedAt: null,
  decisionComment: null,
  approverId: null,
};

const draftApproval = { ...pendingApproval, state: "DRAFT" as const, sealedAt: null };

const inputRequestInput: InputRequest = {
  type: "select",
  prompt: "Which environment should receive this release?",
  options: [
    { id: "staging", label: "Staging" },
    { id: "production", label: "Production", style: "danger" },
  ],
  expiresInSeconds: 900,
  suggestedApproverId: "ApproverAbcd",
  callback: { url: "https://agent.example/callback", state: "opaque-secret-state" },
};

const pendingInput = {
  id: "InputAbcdefg",
  type: "select" as const,
  prompt: inputRequestInput.prompt,
  options: inputRequestInput.options!,
  allowFreeform: false,
  state: "PENDING" as const,
  answer: null,
  attestation: null,
  respondentId: null,
  agentId: "AgentAbcdefg",
  createdAt: "2026-07-15T00:00:00.000Z",
  expiresAt: "2026-07-15T00:15:00.000Z",
  answeredAt: null,
  cancelledAt: null,
};

const answeredInput = {
  ...pendingInput,
  state: "ANSWERED" as const,
  answer: { optionId: "staging" },
  attestation: "opaque-attestation",
  respondentId: "ApproverAbcd",
  answeredAt: "2026-07-15T00:05:00.000Z",
};

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function captured(init: RequestInit | undefined): { headers: Headers; body: string | undefined } {
  return { headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : undefined };
}

function expectSecretSafe(error: unknown, ...secrets: string[]) {
  expect(error).toBeInstanceOf(Error);
  const text = `${(error as Error).message} ${JSON.stringify(error)}`;
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(Object.keys(error as object)).not.toContain("cause");
}

describe("MayiClient approvals.request", () => {
  it("sends the accepted request contract and returns a sealed pending approval in one fetch", async () => {
    const fetchMock = vi.fn<MayiFetch>(async () => jsonResponse(pendingApproval));
    const getAccessToken = vi.fn(async () => "oauth-token");
    const client = new MayiClient({ origin: "https://mayi.example", getAccessToken, fetch: fetchMock });

    await expect(client.approvals.request(requestInput, { idempotencyKey: "stable-key" })).resolves.toEqual(pendingApproval);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://mayi.example/api/approvals/request");
    expect(init?.method).toBe("POST");
    const { headers, body } = captured(init);
    expect(headers.get("authorization")).toBe("Bearer oauth-token");
    expect(init?.credentials).toBe("omit");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("stable-key");
    expect(JSON.parse(body!)).toEqual(requestInput);
    expect(JSON.parse(body!).action).not.toHaveProperty("audience");
  });

  it("gets a fresh access token for every authenticated call", async () => {
    const tokens = ["first-token", "rotated-token"];
    const getAccessToken = vi.fn(async () => tokens.shift() ?? "unexpected");
    const seen: string[] = [];
    const fetchMock = vi.fn<MayiFetch>(async (_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return jsonResponse(pendingApproval);
    });
    const client = new MayiClient({ origin: "https://mayi.example", getAccessToken, fetch: fetchMock });

    await client.approvals.request(requestInput, { idempotencyKey: "key-1" });
    await client.approvals.request(requestInput, { idempotencyKey: "key-2" });

    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["Bearer first-token", "Bearer rotated-token"]);
    expect(JSON.stringify(client)).not.toContain("first-token");
    expect(JSON.stringify(client)).not.toContain("rotated-token");
  });

  it.each([
    ["malformed", { nope: true }],
    ["wrong state", { ...pendingApproval, state: "APPROVED" }],
    ["unsealed", { ...pendingApproval, sealedAt: null }],
    ["missing action digest", { ...pendingApproval, actionDigest: null }],
    ["missing manifest digest", { ...pendingApproval, manifestDigest: null }],
  ])("rejects a %s success response", async (_label, responseBody) => {
    const client = new MayiClient({
      origin: "https://mayi.example",
      getAccessToken: async () => "token",
      fetch: async () => jsonResponse(responseBody),
    });

    await expect(client.approvals.request(requestInput, { idempotencyKey: "stable-key" }))
      .rejects.toBeInstanceOf(MayiResponseError);
  });

  it("rejects invalid JSON success responses", async () => {
    const client = new MayiClient({
      origin: "https://mayi.example",
      getAccessToken: async () => "token",
      fetch: async () => new Response("not-json", { status: 200 }),
    });
    await expect(client.approvals.request(requestInput, { idempotencyKey: "stable-key" }))
      .rejects.toBeInstanceOf(MayiResponseError);
  });

  it.each(["", "   ", "x".repeat(201)])("validates idempotency key before auth or fetch", async (idempotencyKey) => {
    const getAccessToken = vi.fn(async () => "token");
    const fetchMock = vi.fn<MayiFetch>(async () => jsonResponse(pendingApproval));
    const client = new MayiClient({ origin: "https://mayi.example", getAccessToken, fetch: fetchMock });

    await expect(client.approvals.request(requestInput, { idempotencyKey }))
      .rejects.toBeInstanceOf(MayiConfigurationError);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("MayiClient inputs", () => {
  it("sends the accepted input contract and returns a pending input", async () => {
    const fetchMock = vi.fn<MayiFetch>(async () => jsonResponse(pendingInput));
    const getAccessToken = vi.fn(async () => "oauth-token");
    const client = new MayiClient({ origin: "https://mayi.example", getAccessToken, fetch: fetchMock });

    await expect(client.inputs.request(inputRequestInput, { idempotencyKey: "stable-key" })).resolves.toEqual(pendingInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://mayi.example/api/inputs");
    expect(init?.method).toBe("POST");
    const { headers, body } = captured(init);
    expect(headers.get("authorization")).toBe("Bearer oauth-token");
    expect(init?.credentials).toBe("omit");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("stable-key");
    expect(JSON.parse(body!)).toEqual(inputRequestInput);
  });

  it.each([
    ["malformed", { nope: true }],
    ["answered", answeredInput],
    ["expired", { ...pendingInput, state: "EXPIRED" }],
    ["cancelled", { ...pendingInput, state: "CANCELLED", cancelledAt: "2026-07-15T00:05:00.000Z" }],
  ])("rejects a %s success response", async (_label, responseBody) => {
    const client = new MayiClient({
      origin: "https://mayi.example",
      getAccessToken: async () => "token",
      fetch: async () => jsonResponse(responseBody),
    });

    await expect(client.inputs.request(inputRequestInput, { idempotencyKey: "stable-key" }))
      .rejects.toBeInstanceOf(MayiResponseError);
  });

  it.each(["", "   ", "x".repeat(201)])("validates idempotency key before auth or fetch", async (idempotencyKey) => {
    const getAccessToken = vi.fn(async () => "token");
    const fetchMock = vi.fn<MayiFetch>(async () => jsonResponse(pendingInput));
    const client = new MayiClient({ origin: "https://mayi.example", getAccessToken, fetch: fetchMock });

    await expect(client.inputs.request(inputRequestInput, { idempotencyKey }))
      .rejects.toBeInstanceOf(MayiConfigurationError);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails the input request safely when the provider is missing", async () => {
    const fetchMock = vi.fn<MayiFetch>();
    const client = new MayiClient({ origin: "https://mayi.example", fetch: fetchMock });

    await expect(client.inputs.request(inputRequestInput, { idempotencyKey: "stable-key" })).rejects.toMatchObject({
      name: "MayiAuthenticationError",
      code: "ACCESS_TOKEN_PROVIDER_REQUIRED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the configured provider for dual-mode input reads", async () => {
    const responses = [jsonResponse([pendingInput]), jsonResponse(pendingInput)];
    const fetchMock = vi.fn<MayiFetch>(async () => responses.shift()!);
    const getAccessToken = vi.fn(async () => "read-token");
    const client = new MayiClient({ origin: "https://mayi.example", getAccessToken, fetch: fetchMock });

    await expect(client.inputs.list({ state: "PENDING" })).resolves.toEqual([pendingInput]);
    await expect(client.inputs.get("InputAbcdefg")).resolves.toEqual(pendingInput);

    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://mayi.example/api/inputs?state=PENDING");
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://mayi.example/api/inputs/InputAbcdefg");
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer read-token");
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get("authorization")).toBe("Bearer read-token");
  });

  it("requires bearer authentication to cancel an input", async () => {
    const unauthenticatedFetch = vi.fn<MayiFetch>();
    const unauthenticatedClient = new MayiClient({ origin: "https://mayi.example", fetch: unauthenticatedFetch });

    await expect(unauthenticatedClient.inputs.cancel("InputAbcdefg")).rejects.toMatchObject({
      name: "MayiAuthenticationError",
      code: "ACCESS_TOKEN_PROVIDER_REQUIRED",
    });
    expect(unauthenticatedFetch).not.toHaveBeenCalled();

    const getAccessToken = vi.fn(async () => "cancel-token");
    const authenticatedFetch = vi.fn<MayiFetch>(async () => jsonResponse({ ...pendingInput, state: "CANCELLED" }));
    const authenticatedClient = new MayiClient({
      origin: "https://mayi.example",
      getAccessToken,
      fetch: authenticatedFetch,
    });

    await authenticatedClient.inputs.cancel("InputAbcdefg");
    const [url, init] = authenticatedFetch.mock.calls[0]!;
    expect(String(url)).toBe("https://mayi.example/api/inputs/InputAbcdefg/cancel");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cancel-token");
  });

  it("keeps human answers cookie-authenticated when a provider is configured", async () => {
    const getAccessToken = vi.fn(async () => "agent-token");
    const fetchMock = vi.fn<MayiFetch>(async () => jsonResponse(answeredInput));
    const client = new MayiClient({ origin: "https://mayi.example", getAccessToken, fetch: fetchMock });

    await expect(client.answerInput("InputAbcdefg", { optionId: "staging" })).resolves.toEqual(answeredInput);

    expect(getAccessToken).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://mayi.example/api/inputs/InputAbcdefg/answer");
    expect(init?.method).toBe("POST");
    const { headers, body } = captured(init);
    expect(headers.has("authorization")).toBe(false);
    expect(init?.credentials).toBe("include");
    expect(JSON.parse(body!)).toEqual({ optionId: "staging" });
  });

  it("allows cookie-backed browser input reads without an access-token provider", async () => {
    const responses = [jsonResponse([pendingInput]), jsonResponse(pendingInput)];
    const fetchMock = vi.fn<MayiFetch>(async () => responses.shift()!);
    const client = new MayiClient({ origin: "https://mayi.example", fetch: fetchMock });

    await expect(client.listInputs("PENDING")).resolves.toEqual([pendingInput]);
    await expect(client.input("InputAbcdefg")).resolves.toEqual(pendingInput);

    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://mayi.example/api/inputs?state=PENDING");
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://mayi.example/api/inputs/InputAbcdefg");
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.credentials).toBe("include");
    }
  });
});

describe("MayiClient safe failures", () => {
  it.each([
    "http://example.com",
    "http://10.0.0.1:3000",
    "http://192.168.1.10",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])("rejects an insecure origin without acquiring credentials: %s", (origin) => {
    const getAccessToken = vi.fn(async () => "token");
    const fetchMock = vi.fn<MayiFetch>();

    expect(() => new MayiClient({ origin, getAccessToken, fetch: fetchMock }))
      .toThrow(MayiConfigurationError);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "http://example.com",
    "http://10.0.0.1:3000",
    "http://192.168.1.10",
  ])("rejects non-loopback HTTP even with the development opt-in: %s", (origin) => {
    expect(() => new MayiClient({
      origin,
      dangerouslyAllowInsecureHttpForDevelopment: true,
      fetch: vi.fn<MayiFetch>(),
    })).toThrow(MayiConfigurationError);
  });

  it.each([
    "http://user@localhost:3000",
    "http://localhost:3000/api",
    "http://localhost:3000/?debug=1",
    "http://localhost:3000/#debug",
  ])("keeps unsafe URL components forbidden with the development opt-in: %s", (origin) => {
    expect(() => new MayiClient({
      origin,
      dangerouslyAllowInsecureHttpForDevelopment: true,
      fetch: vi.fn<MayiFetch>(),
    })).toThrow(MayiConfigurationError);
  });

  it.each([
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:4321", "http://127.0.0.1:4321"],
    ["http://[::1]:8787", "http://[::1]:8787"],
  ])("allows explicit loopback HTTP development: %s", async (origin, expectedOrigin) => {
    const fetchMock = vi.fn<MayiFetch>(async () => jsonResponse([pendingApproval]));
    const client = new MayiClient({
      origin,
      dangerouslyAllowInsecureHttpForDevelopment: true,
      fetch: fetchMock,
    });

    await client.listApprovals();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${expectedOrigin}/api/approvals`);
  });

  it("fails authenticated calls safely when the provider is missing", async () => {
    const fetchMock = vi.fn<MayiFetch>();
    const client = new MayiClient({ origin: "https://mayi.example", fetch: fetchMock });
    const promise = client.approvals.request(requestInput, { idempotencyKey: "stable-key" });
    await expect(promise).rejects.toMatchObject({
      name: "MayiAuthenticationError",
      code: "ACCESS_TOKEN_PROVIDER_REQUIRED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "token with spaces", "token\nsecret"])("rejects an invalid token without fetching", async (token) => {
    const fetchMock = vi.fn<MayiFetch>();
    const client = new MayiClient({ origin: "https://mayi.example", getAccessToken: async () => token, fetch: fetchMock });
    await expect(client.approvals.request(requestInput, { idempotencyKey: "stable-key" }))
      .rejects.toBeInstanceOf(MayiAuthenticationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expose a rejected provider's error", async () => {
    const secret = "provider-secret-token";
    const client = new MayiClient({
      origin: "https://mayi.example",
      getAccessToken: async () => { throw new Error(`refresh failed for ${secret}`); },
      fetch: vi.fn<MayiFetch>(),
    });
    const error = await client.approvals.request(requestInput, { idempotencyKey: "stable-key" }).catch((cause) => cause);
    expect(error).toBeInstanceOf(MayiAuthenticationError);
    expectSecretSafe(error, secret, requestInput.callback.state);
  });

  it("does not expose a fetch failure", async () => {
    const secret = "network-secret";
    const client = new MayiClient({
      origin: "https://mayi.example",
      getAccessToken: async () => "token",
      fetch: async () => { throw new Error(`socket failed with ${secret}`); },
    });
    const error = await client.approvals.request(requestInput, { idempotencyKey: "stable-key" }).catch((cause) => cause);
    expect(error).toBeInstanceOf(MayiNetworkError);
    expectSecretSafe(error, secret, "token", requestInput.callback.state);
  });

  it("does not expose an HTTP response body", async () => {
    const secret = "response-secret-receipt";
    const client = new MayiClient({
      origin: "https://mayi.example",
      getAccessToken: async () => "token",
      fetch: async () => jsonResponse({ message: `failed: ${secret}` }, { status: 403 }),
    });
    const error = await client.approvals.request(requestInput, { idempotencyKey: "stable-key" }).catch((cause) => cause);
    expect(error).toBeInstanceOf(MayiHttpError);
    expect(error).toMatchObject({ status: 403 });
    expectSecretSafe(error, secret, "token", requestInput.callback.state);
  });

  it("exposes only the allowlisted step-up error code needed by browser clients", async () => {
    const client = new MayiClient({
      origin: "https://mayi.example",
      fetch: async () => jsonResponse({ data: { code: "step_up_required", detail: "not-exposed-secret" } }, { status: 403 }),
    });
    const error = await client.decide("ApprovalAbcd", { decision: "APPROVED" }).catch((cause) => cause);
    expect(error).toMatchObject({ status: 403, code: "step_up_required" });
    expectSecretSafe(error, "not-exposed-secret");
  });

  it("does not expose unrecognized service error codes", async () => {
    const client = new MayiClient({
      origin: "https://mayi.example",
      fetch: async () => jsonResponse({ data: { code: "private-diagnostic-secret" } }, { status: 403 }),
    });
    const error = await client.decide("ApprovalAbcd", { decision: "APPROVED" }).catch((cause) => cause);
    expect(error).toMatchObject({ status: 403, code: undefined });
    expectSecretSafe(error, "private-diagnostic-secret");
  });
});

describe("MayiClient password reset", () => {
  it("requests a reset link with cookie credentials and a JSON body", async () => {
    const fetchMock = vi.fn<MayiFetch>(async () => jsonResponse({ ok: true }));
    const client = new MayiClient({ origin: "https://mayi.example", fetch: fetchMock });

    await expect(client.passwordResetRequest({ email: "person@example.com" })).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    const { headers, body } = captured(init);
    expect(String(url)).toBe("https://mayi.example/api/auth/password-reset/request");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
    expect(JSON.parse(body!)).toEqual({ email: "person@example.com" });
  });

  it("confirms a reset with the token and new password", async () => {
    const fetchMock = vi.fn<MayiFetch>(async () => jsonResponse({ ok: true }));
    const client = new MayiClient({ origin: "https://mayi.example", fetch: fetchMock });

    await expect(client.passwordResetConfirm({ token: "reset-token", password: "n3w-Passw0rd!" })).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    const { headers, body } = captured(init);
    expect(String(url)).toBe("https://mayi.example/api/auth/password-reset/confirm");
    expect(init?.method).toBe("POST");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(body!)).toEqual({ token: "reset-token", password: "n3w-Passw0rd!" });
  });

  it("surfaces an invalid or expired token as a 400 without exposing the body", async () => {
    const secret = "token-diagnostic-secret";
    const client = new MayiClient({
      origin: "https://mayi.example",
      fetch: async () => jsonResponse({ message: secret }, { status: 400 }),
    });
    const error = await client.passwordResetConfirm({ token: "stale", password: "n3w-Passw0rd!" }).catch((cause) => cause);
    expect(error).toBeInstanceOf(MayiHttpError);
    expect(error).toMatchObject({ status: 400 });
    expectSecretSafe(error, secret);
  });

  it("surfaces a weak password as a 422", async () => {
    const client = new MayiClient({
      origin: "https://mayi.example",
      fetch: async () => jsonResponse({ message: "weak" }, { status: 422 }),
    });
    await expect(client.passwordResetConfirm({ token: "reset-token", password: "short" }))
      .rejects.toMatchObject({ name: "MayiHttpError", status: 422 });
  });
});

describe("MayiClient artifact and browser workflows", () => {
  it("stages request-bound evidence with an ordinal and stable idempotency key", async () => {
    const uploaded = {
      id: "ArtefactAbcd",
      filename: "release proof.pdf",
      mediaType: "application/pdf",
      size: 9,
      sha256: "c".repeat(64),
    };
    const fetchMock = vi.fn<MayiFetch>(async () => jsonResponse(uploaded));
    const client = new MayiClient({
      origin: "https://mayi.example",
      getAccessToken: async () => "stage-token",
      fetch: fetchMock,
    });
    const bytes = new TextEncoder().encode("%PDF-test");

    await expect(client.stageRequestArtefact(
      "request-key",
      0,
      "release proof.pdf",
      "application/pdf",
      bytes,
    )).resolves.toEqual(uploaded);

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(String(url)).toBe("https://mayi.example/api/approvals/request/artefacts/0");
    expect(init?.body).toBe(bytes);
    expect(headers.get("authorization")).toBe("Bearer stage-token");
    expect(headers.get("idempotency-key")).toBe("request-key");
    expect(headers.get("x-mayi-filename")).toBe("release%20proof.pdf");
    expect(headers.get("content-length")).toBe("9");
  });

  it("rejects invalid staged evidence before authentication or upload", async () => {
    const getAccessToken = vi.fn(async () => "token");
    const fetchMock = vi.fn<MayiFetch>();
    const client = new MayiClient({ origin: "https://mayi.example", getAccessToken, fetch: fetchMock });

    await expect(client.stageRequestArtefact(
      "request-key",
      20,
      "proof.pdf",
      "application/pdf",
      new Uint8Array([1]),
    )).rejects.toBeInstanceOf(MayiConfigurationError);
    await expect(client.stageRequestArtefact(
      "request-key",
      0,
      "proof.pdf",
      "text/plain" as never,
      new Uint8Array([1]),
    )).rejects.toBeInstanceOf(MayiConfigurationError);
    await expect(client.stageRequestArtefact(
      "request-key",
      0,
      "proof.pdf",
      "application/pdf",
      new Uint8Array(25 * 1024 * 1024 + 1),
    )).rejects.toBeInstanceOf(MayiConfigurationError);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps draft, binary upload, and seal operations with fresh bearer tokens", async () => {
    const createInput: CreateApproval = {
      action: {
        kind: "deploy.release",
        version: "1",
        audience: "production-deployer",
        input: { releaseDigest: "sha256:abc" },
      },
      explanation: "Deploy after review.",
      expiresInSeconds: 900,
      enforcement: "verified",
    };
    const uploaded = {
      id: "ArtefactAbcd",
      filename: "release proof.pdf",
      mediaType: "application/pdf",
      size: 3,
      sha256: "c".repeat(64),
    };
    const responses = [jsonResponse(draftApproval), jsonResponse(uploaded), jsonResponse(pendingApproval)];
    const fetchMock = vi.fn<MayiFetch>(async () => responses.shift()!);
    const tokens = ["token-one", "token-two", "token-three"];
    const getAccessToken = vi.fn(async () => tokens.shift()!);
    const client = new MayiClient({ origin: "https://mayi.example", getAccessToken, fetch: fetchMock });

    await client.createApproval(createInput, "draft-key");
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(client.uploadArtefact("ApprovalAbcd", "release proof.pdf", "application/pdf", bytes)).resolves.toEqual(uploaded);
    await client.sealApproval("ApprovalAbcd", ["ArtefactAbcd"]);

    expect(getAccessToken).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization")))
      .toEqual(["Bearer token-one", "Bearer token-two", "Bearer token-three"]);
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1]!;
    expect(String(uploadUrl)).toBe("https://mayi.example/api/approvals/ApprovalAbcd/artefacts?filename=release%20proof.pdf");
    expect(uploadInit?.body).toBe(bytes);
    expect(new Headers(uploadInit?.headers).get("content-type")).toBe("application/pdf");
  });

  it("allows cookie-backed browser reads without an access-token provider", async () => {
    const fetchMock = vi.fn<MayiFetch>(async () => jsonResponse([pendingApproval]));
    const client = new MayiClient({ origin: "https://mayi.example", fetch: fetchMock });

    await expect(client.listApprovals("PENDING")).resolves.toEqual([pendingApproval]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://mayi.example/api/approvals?state=PENDING");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.credentials).toBe("include");
  });

  it("uses the configured provider for dual-mode reads", async () => {
    const fetchMock = vi.fn<MayiFetch>(async () => jsonResponse(pendingApproval));
    const getAccessToken = vi.fn(async () => "read-token");
    const client = new MayiClient({ origin: "https://mayi.example", getAccessToken, fetch: fetchMock });

    await client.approval("ApprovalAbcd");
    expect(getAccessToken).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer read-token");
  });

  it("requires bearer authentication to cancel an approval", async () => {
    const unauthenticatedFetch = vi.fn<MayiFetch>();
    const unauthenticatedClient = new MayiClient({ origin: "https://mayi.example", fetch: unauthenticatedFetch });

    await expect(unauthenticatedClient.cancel("ApprovalAbcd")).rejects.toMatchObject({
      name: "MayiAuthenticationError",
      code: "ACCESS_TOKEN_PROVIDER_REQUIRED",
    });
    expect(unauthenticatedFetch).not.toHaveBeenCalled();

    const getAccessToken = vi.fn(async () => "cancel-token");
    const authenticatedFetch = vi.fn<MayiFetch>(async () => jsonResponse({ ...pendingApproval, state: "CANCELLED" }));
    const authenticatedClient = new MayiClient({
      origin: "https://mayi.example",
      getAccessToken,
      fetch: authenticatedFetch,
    });

    await authenticatedClient.cancel("ApprovalAbcd");
    expect(getAccessToken).toHaveBeenCalledOnce();
    expect(new Headers(authenticatedFetch.mock.calls[0]![1]?.headers).get("authorization"))
      .toBe("Bearer cancel-token");
  });

  it("keeps human decisions cookie-authenticated when a provider is configured", async () => {
    const getAccessToken = vi.fn(async () => "agent-token");
    const fetchMock = vi.fn<MayiFetch>(async () => jsonResponse({ ...pendingApproval, state: "APPROVED" }));
    const client = new MayiClient({ origin: "https://mayi.example", getAccessToken, fetch: fetchMock });

    await client.decide("ApprovalAbcd", { decision: "APPROVED" });

    expect(getAccessToken).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.credentials).toBe("include");
  });
});
