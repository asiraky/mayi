import { canonicalize, createId } from "@mayi/contracts";
import { createCallbackStateCodec } from "@mayi/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mayiChannel } from "../../../../packages/eve/src/channel";
import jwksHandler from "../routes/.well-known/jwks.json.get";
import { callbackEvent } from "./callback-outbox";
import { signWebhook } from "./forwarding";

const signerState = globalThis as typeof globalThis & { __mayiKeys?: unknown };

async function signingEnvironment() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const kid = "eve-resume-integration";
  const privateJwk = { ...await crypto.subtle.exportKey("jwk", pair.privateKey), kid };
  const publicJwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid };
  delete privateJwk.alg;
  delete publicJwk.alg;
  vi.stubEnv("RECEIPT_PRIVATE_JWK", JSON.stringify(privateJwk));
  vi.stubEnv("RECEIPT_PUBLIC_JWK", JSON.stringify(publicJwk));
  delete signerState.__mayiKeys;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete signerState.__mayiKeys;
});

describe("production server to Eve approval resume", () => {
  it("composes, signs, publishes, verifies, decrypts, and resumes one real server event", async () => {
    await signingEnvironment();
    const clock = Date.now();
    const callbackStateCodec = await createCallbackStateCodec({
      currentKey: { kid: "eve-state-integration", key: new Uint8Array(32).fill(19) },
      maximumRetryWindowSeconds: 3_833,
      now: () => clock,
    });
    const rawContinuationToken = "mayi:production-handshake-raw-token";
    const requestId = "eve-request-production";
    const sessionId = "eve-session-production";
    const sealedState = await callbackStateCodec.seal({
      version: 1,
      rawContinuationToken,
      requestId,
      sessionId,
      expiresAt: new Date(clock + 2 * 60 * 60 * 1_000).toISOString(),
    }, { approvalExpiresAt: new Date(clock + 60 * 60 * 1_000).toISOString() });
    const event = callbackEvent({
      id: createId(),
      approval_id: createId(),
      workspace_id: createId(),
      url: "https://agent.example/eve/v1/mayi/approval-resolved",
      state: sealedState,
      delivery_status: "RUNNING",
      occurred_at: new Date(clock),
      approval_state: "APPROVED",
      approver_id: createId(),
      compact_jws: "production-receipt-fixture",
    });
    const signature = await signWebhook(event);
    const webhookFetch = vi.fn(async () => Response.json(await jwksHandler({} as never)));
    const marked: string[] = [];
    const channel = mayiChannel({
      getAccessToken: async () => "fabricated-eden-oauth-token",
      mayiOrigin: "https://mayi.example",
      callbackStateCodec,
      environment: {},
      webhookFetch,
      eventStore: {
        isProcessed: async () => false,
        markProcessed: async (eventId) => { marked.push(eventId); },
      },
    });
    const route = channel.routes[0]!;
    if (route.transport === "websocket") throw new Error("Expected the Eve HTTP callback route");
    const send = vi.fn(async () => ({
      id: sessionId,
      continuationToken: `channels/mayi:${rawContinuationToken}`,
      getEventStream: async () => new ReadableStream(),
    }));

    const response = await route.handler(new Request(
      "https://agent.example/eve/v1/mayi/approval-resolved",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-mayi-signature": signature },
        body: canonicalize(event),
      },
    ), {
      send,
      getSession: vi.fn(),
      params: {},
      receive: vi.fn(),
      waitUntil: vi.fn(),
      requestIp: null,
    } as never);

    expect(response.status).toBe(202);
    expect(webhookFetch).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      inputResponses: [{ requestId, optionId: "approve" }],
    }, {
      auth: null,
      continuationToken: rawContinuationToken,
      state: { rawContinuationToken, target: null },
    });
    expect(marked).toEqual([event.id]);
  });
});
