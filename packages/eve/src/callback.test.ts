import {
  MAYI_SIGNATURE_HEADER,
  createCallbackStateCodec,
  createWebhookVerifier,
  type CallbackStateCodec,
} from "@mayi/sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../contracts/src/canonical";
import { createId } from "../../contracts/src/id";
import {
  mayiChannel,
  type MayiChannelState,
  type MayiContinuationStateV1,
  type MayiWebhookEventStore,
} from "./channel";
import { MAYI_CALLBACK_PATH } from "./origin";

const now = Date.now();
const stateKey = new Uint8Array(32).fill(7);

type TerminalStatus = "approved" | "denied" | "expired" | "cancelled";

interface SigningFixture {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey & { kid: string };
}

interface CallbackEvent {
  id: string;
  type: "approval.resolved";
  version: 1;
  approvalId: string;
  status: TerminalStatus;
  state: string;
  occurredAt: string;
  approver?: { id: string };
  receipt?: string;
}

let signing: SigningFixture;
let otherSigning: SigningFixture;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signingFixture(kid: string): Promise<SigningFixture> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicJwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid },
  };
}

async function sign(value: unknown, fixture = signing, kid = fixture.publicJwk.kid): Promise<string> {
  const header = base64Url(new TextEncoder().encode(JSON.stringify({
    alg: "EdDSA",
    kid,
    typ: "mayi-webhook+jws",
  })));
  const payload = base64Url(new TextEncoder().encode(canonicalize(value)));
  const signature = await crypto.subtle.sign(
    "Ed25519",
    fixture.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

beforeAll(async () => {
  [signing, otherSigning] = await Promise.all([
    signingFixture("callback-signing-key"),
    signingFixture("callback-signing-key"),
  ]);
});

async function realCodec(key = stateKey, kid = "callback-state-key", codecNow = now) {
  return createCallbackStateCodec({
    currentKey: { kid, key },
    maximumRetryWindowSeconds: 3_833,
    now: () => codecNow,
  });
}

async function sealedState(
  codec: CallbackStateCodec,
  overrides: Partial<MayiContinuationStateV1> = {},
): Promise<string> {
  return codec.seal({
    version: 1,
    rawContinuationToken: "mayi:original-raw-token",
    requestId: "request-original",
    sessionId: "session-original",
    expiresAt: new Date(now + 2 * 60 * 60 * 1_000).toISOString(),
    ...overrides,
  }, { approvalExpiresAt: new Date(now + 60 * 60 * 1_000).toISOString() });
}

function callbackEvent(state: string, status: TerminalStatus = "approved", overrides: Partial<CallbackEvent> = {}): CallbackEvent {
  return {
    id: createId(),
    type: "approval.resolved",
    version: 1,
    approvalId: createId(),
    status,
    state,
    occurredAt: new Date(now).toISOString(),
    ...((status === "approved" || status === "denied") ? { approver: { id: createId() } } : {}),
    ...(status === "approved" ? { receipt: "fabricated-compact-receipt" } : {}),
    ...overrides,
  };
}

async function callbackRequest(
  event: CallbackEvent,
  options: { body?: string; signature?: string | null } = {},
): Promise<Request> {
  const body = options.body ?? canonicalize(event);
  const signature = options.signature === undefined ? await sign(event) : options.signature;
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set(MAYI_SIGNATURE_HEADER, signature);
  return new Request(`https://agent.example${MAYI_CALLBACK_PATH}`, { method: "POST", headers, body });
}

function streamOf(events: unknown[]) {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
}

function routeArgs(
  send: ReturnType<typeof vi.fn>,
  events: unknown[] = [],
) {
  return {
    send,
    getSession: vi.fn(() => ({
      id: "session-original",
      continuationToken: "channels/mayi:mayi:original-raw-token",
      getEventStream: async () => streamOf(events),
    })),
    params: {},
    receive: vi.fn(),
    waitUntil: vi.fn(),
    requestIp: null,
  };
}

function callbackRoute(config: {
  callbackStateCodec: CallbackStateCodec;
  eventStore?: MayiWebhookEventStore;
}) {
  const channel = mayiChannel({
    getAccessToken: async () => "fabricated-oauth-token",
    mayiOrigin: "https://mayi.example",
    callbackStateCodec: config.callbackStateCodec,
    environment: {},
    fetch: async () => { throw new Error("Mayi API must not be called by callbacks"); },
    webhookFetch: async () => Response.json({
      keys: [{ ...signing.publicJwk, use: "sig", alg: "EdDSA" }],
    }),
    ...(config.eventStore === undefined ? {} : { eventStore: config.eventStore }),
  });
  const route = channel.routes[0]!;
  if (route.transport === "websocket") throw new Error("Expected HTTP route");
  return route.handler;
}

function acceptedSession(sessionId = "session-original") {
  return {
    id: sessionId,
    continuationToken: "channels/mayi:mayi:original-raw-token",
    getEventStream: async () => streamOf([]),
  };
}

describe("approval-resolved callback", () => {
  it("uses verifier-compatible Ed25519 fixtures", async () => {
    const event = callbackEvent("opaque-state");
    const verifier = createWebhookVerifier({
      mayiOrigin: "https://mayi.example",
      maximumEventAgeSeconds: 3_833,
      now: () => now,
      fetch: async () => Response.json({ keys: [{ ...signing.publicJwk, use: "sig", alg: "EdDSA" }] }),
    });
    await expect(verifier.verify({ body: canonicalize(event), signature: await sign(event) }))
      .resolves.toMatchObject({ duplicate: false, event: { id: event.id } });
  });

  it.each([
    ["approved", "approve"],
    ["denied", "deny"],
    ["expired", "deny"],
    ["cancelled", "deny"],
  ] as const)("maps %s to Eve option %s and marks only after acceptance", async (status, optionId) => {
    const codec = await realCodec();
    const state = await sealedState(codec);
    const order: string[] = [];
    const processed = new Set<string>();
    const eventStore: MayiWebhookEventStore = {
      isProcessed: vi.fn((eventId) => processed.has(eventId)),
      markProcessed: vi.fn((eventId) => { order.push("mark"); processed.add(eventId); }),
    };
    const send = vi.fn(async () => { order.push("send"); return acceptedSession(); });
    const event = callbackEvent(state, status);

    const response = await callbackRoute({ callbackStateCodec: codec, eventStore })(
      await callbackRequest(event),
      routeArgs(send) as never,
    );

    expect(response.status).toBe(202);
    expect(order).toEqual(["send", "mark"]);
    expect(send).toHaveBeenCalledWith({
      inputResponses: [{ requestId: "request-original", optionId }],
    }, {
      auth: null,
      continuationToken: "mayi:original-raw-token",
      state: { rawContinuationToken: "mayi:original-raw-token", target: null },
    });
    expect(eventStore.markProcessed).toHaveBeenCalledWith(event.id);
  });

  it("acknowledges a verified duplicate without decrypting or resuming", async () => {
    const delegate = await realCodec();
    const open = vi.fn((value: string) => delegate.open<unknown>(value));
    const codec: CallbackStateCodec = {
      seal: delegate.seal.bind(delegate),
      async open<T>(value: string) { return await open(value) as T; },
    };
    const state = await sealedState(codec);
    const processed = new Set<string>();
    const eventStore: MayiWebhookEventStore = {
      isProcessed: vi.fn((eventId) => processed.has(eventId)),
      markProcessed: vi.fn((eventId) => { processed.add(eventId); }),
    };
    const send = vi.fn(async () => acceptedSession());
    const event = callbackEvent(state);
    const handler = callbackRoute({ callbackStateCodec: codec, eventStore });
    const args = routeArgs(send);

    expect((await handler(await callbackRequest(event), args as never)).status).toBe(202);
    expect((await handler(await callbackRequest(event), args as never)).status).toBe(208);
    expect(send).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("uses Eve's continuation fence and durable result to acknowledge duplicates without a host store", async () => {
    const codec = await realCodec();
    const state = await sealedState(codec);
    const send = vi.fn()
      .mockResolvedValueOnce(acceptedSession())
      .mockRejectedValueOnce(new Error("no active continuation"));
    const event = callbackEvent(state);
    const handler = callbackRoute({ callbackStateCodec: codec });
    const events = [
      {
        type: "input.requested",
        data: { requests: [{
          requestId: "request-original",
          action: { kind: "tool-call", callId: "call-original", toolName: "deploy", input: {} },
        }] },
      },
      {
        type: "action.result",
        data: { result: { kind: "tool-result", callId: "call-original", toolName: "deploy", output: "done" } },
      },
    ];
    const args = routeArgs(send, events);

    expect((await handler(await callbackRequest(event), args as never)).status).toBe(202);
    expect((await handler(await callbackRequest(event), args as never)).status).toBe(208);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retries after a crash before acceptance, then acknowledges the stable duplicate", async () => {
    const codec = await realCodec();
    const state = await sealedState(codec);
    const processed = new Set<string>();
    const eventStore: MayiWebhookEventStore = {
      isProcessed: vi.fn((eventId) => processed.has(eventId)),
      markProcessed: vi.fn((eventId) => { processed.add(eventId); }),
    };
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("crash before Eve acceptance"))
      .mockResolvedValueOnce(acceptedSession());
    const event = callbackEvent(state);
    const handler = callbackRoute({ callbackStateCodec: codec, eventStore });
    const args = routeArgs(send);

    expect((await handler(await callbackRequest(event), args as never)).status).toBe(503);
    expect(eventStore.markProcessed).not.toHaveBeenCalled();
    expect((await handler(await callbackRequest(event), args as never)).status).toBe(202);
    expect((await handler(await callbackRequest(event), args as never)).status).toBe(208);
    expect(send).toHaveBeenCalledTimes(2);
    expect(eventStore.markProcessed).toHaveBeenCalledTimes(1);
  });

  it("recovers an acceptance-to-marker crash from Eve's durable event stream", async () => {
    const codec = await realCodec();
    const state = await sealedState(codec);
    let markAttempts = 0;
    const eventStore: MayiWebhookEventStore = {
      isProcessed: vi.fn(() => false),
      markProcessed: vi.fn(() => {
        markAttempts += 1;
        if (markAttempts === 1) throw new Error("marker store unavailable");
      }),
    };
    const send = vi.fn()
      .mockResolvedValueOnce(acceptedSession())
      .mockRejectedValueOnce(new Error("no active continuation"));
    const event = callbackEvent(state);
    const handler = callbackRoute({ callbackStateCodec: codec, eventStore });
    const events = [
      {
        type: "input.requested",
        data: { requests: [{
          requestId: "request-original",
          action: { kind: "tool-call", callId: "call-original", toolName: "deploy", input: {} },
        }] },
      },
      {
        type: "action.result",
        data: { result: { kind: "tool-result", callId: "call-original", toolName: "deploy", output: "done" } },
      },
    ];
    const args = routeArgs(send, events);

    expect((await handler(await callbackRequest(event), args as never)).status).toBe(503);
    expect((await handler(await callbackRequest(event), args as never)).status).toBe(208);
    expect(eventStore.markProcessed).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("verifies signatures, body, and freshness before touching ciphertext or Eve", async () => {
    const delegate = await realCodec();
    const state = await sealedState(delegate);
    const event = callbackEvent(state);
    const validSignature = await sign(event);
    const stale = callbackEvent(state, "approved", {
      occurredAt: new Date(now - 4 * 60 * 60 * 1_000).toISOString(),
    });
    const bodyMismatch = canonicalize({ ...event, state: `${state}-changed` });
    const validParts = validSignature.split(".");
    const signatureBytes = validParts[2]!;
    const tamperedSignature = `${validParts[0]}.${validParts[1]}.${signatureBytes[0] === "A" ? "B" : "A"}${signatureBytes.slice(1)}`;
    const cases: [string, Request][] = [
      ["missing", await callbackRequest(event, { signature: null })],
      ["malformed", await callbackRequest(event, { signature: "not-a-jws" })],
      ["tampered", await callbackRequest(event, { signature: tamperedSignature })],
      ["body-mismatched", await callbackRequest(event, { body: bodyMismatch, signature: validSignature })],
      ["stale", await callbackRequest(stale)],
      ["wrong-key", await callbackRequest(event, { signature: await sign(event, otherSigning) })],
      ["unknown-kid", await callbackRequest(event, { signature: await sign(event, signing, "unknown-key") })],
    ];

    for (const [name, request] of cases) {
      const open = vi.fn((value: string) => delegate.open<unknown>(value));
      const codec: CallbackStateCodec = {
        seal: delegate.seal.bind(delegate),
        async open<T>(value: string) { return await open(value) as T; },
      };
      const send = vi.fn(async () => acceptedSession());
      const response = await callbackRoute({ callbackStateCodec: codec })(request, routeArgs(send) as never);
      expect(response.status, name).toBeGreaterThanOrEqual(400);
      expect(open, name).not.toHaveBeenCalled();
      expect(send, name).not.toHaveBeenCalled();
    }
  });

  it("fails closed on authenticated state tamper, rotation, expiry, and version errors", async () => {
    const codec = await realCodec();
    const valid = await sealedState(codec);
    const envelope = JSON.parse(valid) as { version: number; kid: string; nonce: string; ciphertext: string };
    const wrongKeyCodec = await realCodec(new Uint8Array(32).fill(9));
    const unknownKidCodec = await realCodec(stateKey, "unknown-state-key");
    const states = {
      tampered: canonicalize({
        ...envelope,
        ciphertext: `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`,
      }),
      "wrong-key": await sealedState(wrongKeyCodec),
      "unknown-kid": await sealedState(unknownKidCodec),
      "unsupported-envelope-version": canonicalize({ ...envelope, version: 2 }),
      "unsupported-payload-version": await codec.seal({
        version: 2,
        rawContinuationToken: "mayi:original-raw-token",
        requestId: "request-original",
        sessionId: "session-original",
        expiresAt: new Date(now + 2 * 60 * 60 * 1_000).toISOString(),
      }, { approvalExpiresAt: new Date(now + 60 * 60 * 1_000).toISOString() }),
      "expired-payload": await sealedState(codec, { expiresAt: new Date(now - 1_000).toISOString() }),
    };

    for (const [name, state] of Object.entries(states)) {
      const send = vi.fn(async () => acceptedSession());
      const response = await callbackRoute({ callbackStateCodec: codec })(
        await callbackRequest(callbackEvent(state)),
        routeArgs(send) as never,
      );
      expect(response.status, name).toBe(400);
      expect(send, name).not.toHaveBeenCalled();
    }
  });

  it("correlates multiple Eve requests independently", async () => {
    const codec = await realCodec();
    const send = vi.fn(async (_input, options: { state: MayiChannelState }) => acceptedSession(
      options.state.rawContinuationToken === "mayi:raw-one" ? "session-one" : "session-two",
    ));
    const handler = callbackRoute({ callbackStateCodec: codec });
    const firstState = await sealedState(codec, {
      rawContinuationToken: "mayi:raw-one", requestId: "request-one", sessionId: "session-one",
    });
    const secondState = await sealedState(codec, {
      rawContinuationToken: "mayi:raw-two", requestId: "request-two", sessionId: "session-two",
    });

    expect((await handler(
      await callbackRequest(callbackEvent(firstState, "approved")),
      routeArgs(send) as never,
    )).status).toBe(202);
    expect((await handler(
      await callbackRequest(callbackEvent(secondState, "denied")),
      routeArgs(send) as never,
    )).status).toBe(202);
    expect(send.mock.calls).toEqual([
      [
        { inputResponses: [{ requestId: "request-one", optionId: "approve" }] },
        { auth: null, continuationToken: "mayi:raw-one", state: { rawContinuationToken: "mayi:raw-one", target: null } },
      ],
      [
        { inputResponses: [{ requestId: "request-two", optionId: "deny" }] },
        { auth: null, continuationToken: "mayi:raw-two", state: { rawContinuationToken: "mayi:raw-two", target: null } },
      ],
    ]);
  });

  it("does not log callback bodies, state, tokens, credentials, or receipts", async () => {
    const codec = await realCodec();
    const state = await sealedState(codec);
    const consoleSpies = (["debug", "error", "info", "log", "warn"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined));
    try {
      const send = vi.fn(async () => acceptedSession());
      const event = { ...callbackEvent(state), receipt: "secret-receipt" };
      const response = await callbackRoute({ callbackStateCodec: codec })(
        await callbackRequest(event),
        routeArgs(send) as never,
      );
      expect(response.status).toBe(202);
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
