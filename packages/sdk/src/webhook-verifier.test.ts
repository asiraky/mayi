import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { canonicalize, type ApprovalResolvedEvent } from "@mayi/contracts";
import { CompactSign, exportJWK, generateKeyPair, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAYI_JWKS_PATH,
  WebhookConfigurationError,
  WebhookVerificationError,
  createWebhookVerifier,
  type WebhookVerifierOptions,
} from "./webhook-verifier";

const now = Date.parse("2026-07-15T00:00:00.000Z");
const baseEvent: ApprovalResolvedEvent = {
  id: "EventABCDEFG",
  type: "approval.resolved",
  version: 1,
  approvalId: "ApprovalABCD",
  state: "opaque-callback-state",
  occurredAt: new Date(now - 1_000).toISOString(),
  status: "approved",
  approver: { id: "ApproverABCD" },
  receipt: "opaque-receipt",
};

interface SigningFixture {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

let server: Server;
let origin: string;
let first: SigningFixture;
let second: SigningFixture;
let unknown: SigningFixture;
let servedKeys: JWK[] = [];
let jwksRequests = 0;
let rawJwks: string | undefined;

async function signingFixture(kid: string): Promise<SigningFixture> {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: { ...(await exportJWK(pair.publicKey)), kid, use: "sig", alg: "EdDSA" },
  };
}

async function sign(
  event: unknown,
  fixture = first,
  headers: Record<string, unknown> = {},
): Promise<string> {
  return new CompactSign(new TextEncoder().encode(canonicalize(event)))
    .setProtectedHeader({ alg: "EdDSA", kid: fixture.kid, typ: "mayi-webhook+jws", ...headers })
    .sign(fixture.privateKey);
}

function options(overrides: Partial<WebhookVerifierOptions> = {}): WebhookVerifierOptions {
  return {
    mayiOrigin: origin,
    maximumEventAgeSeconds: 300,
    clockToleranceSeconds: 5,
    dangerouslyAllowInsecureHttpForTests: true,
    now: () => now,
    ...overrides,
  };
}

function code(value: string) {
  return expect.objectContaining({ code: value });
}

function replaceProtectedHeader(token: string, update: Record<string, unknown>): string {
  const parts = token.split(".");
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
  parts[0] = Buffer.from(JSON.stringify({ ...header, ...update })).toString("base64url");
  return parts.join(".");
}

beforeAll(async () => {
  [first, second, unknown] = await Promise.all([
    signingFixture("signing-key-1"),
    signingFixture("signing-key-2"),
    signingFixture("unknown-key"),
  ]);
  server = createServer((request, response) => {
    if (request.url !== MAYI_JWKS_PATH) {
      response.writeHead(404).end();
      return;
    }
    jwksRequests += 1;
    response.setHeader("content-type", "application/json");
    response.end(rawJwks ?? JSON.stringify({ keys: servedKeys }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  servedKeys = [first.publicJwk];
  jwksRequests = 0;
  rawJwks = undefined;
});

describe("webhook verifier", () => {
  it("verifies a real Ed25519 compact JWS against the local JWKS endpoint", async () => {
    const verifier = createWebhookVerifier(options());
    const signature = await sign(baseEvent);

    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature })).resolves.toEqual({
      duplicate: false,
      event: baseEvent,
    });
    expect(jwksRequests).toBe(1);
  });

  it("canonicalizes the raw JSON body with the contracts helper before exact byte comparison", async () => {
    const verifier = createWebhookVerifier(options());
    const signature = await sign(baseEvent);
    const differentlyOrderedBody = JSON.stringify({
      receipt: baseEvent.receipt,
      status: baseEvent.status,
      occurredAt: baseEvent.occurredAt,
      state: baseEvent.state,
      approvalId: baseEvent.approvalId,
      version: baseEvent.version,
      type: baseEvent.type,
      id: baseEvent.id,
      approver: baseEvent.approver,
    }, null, 2);

    await expect(verifier.verify({ body: differentlyOrderedBody, signature })).resolves.toMatchObject({
      duplicate: false,
      event: baseEvent,
    });
  });

  it("refreshes a fresh cache for an unknown kid and supports signing-key rotation", async () => {
    const verifier = createWebhookVerifier(options({ cacheTtlSeconds: 600 }));
    await verifier.verify({ body: JSON.stringify(baseEvent), signature: await sign(baseEvent, first) });
    expect(jwksRequests).toBe(1);

    servedKeys = [first.publicJwk, second.publicJwk];
    await verifier.verify({ body: JSON.stringify(baseEvent), signature: await sign(baseEvent, second) });
    expect(jwksRequests).toBe(2);

    await verifier.verify({ body: JSON.stringify(baseEvent), signature: await sign(baseEvent, first) });
    expect(jwksRequests).toBe(2);
  });

  it("expires the bounded JWKS cache", async () => {
    let clock = now;
    const verifier = createWebhookVerifier(options({ cacheTtlSeconds: 1, now: () => clock }));
    const signature = await sign(baseEvent);
    await verifier.verify({ body: JSON.stringify(baseEvent), signature });
    await verifier.verify({ body: JSON.stringify(baseEvent), signature });
    expect(jwksRequests).toBe(1);

    clock += 1_001;
    await verifier.verify({ body: JSON.stringify(baseEvent), signature });
    expect(jwksRequests).toBe(2);
  });

  it("rejects missing, malformed, wrong-algorithm, wrong-type, and unknown-kid signatures", async () => {
    const verifier = createWebhookVerifier(options());
    const signature = await sign(baseEvent);

    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature: undefined }))
      .rejects.toEqual(code("MISSING_SIGNATURE"));
    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature: "not-a-jws" }))
      .rejects.toEqual(code("MALFORMED_SIGNATURE"));
    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature: replaceProtectedHeader(signature, { alg: "HS256" }) }))
      .rejects.toEqual(code("UNSUPPORTED_ALGORITHM"));
    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature: await sign(baseEvent, first, { typ: "JWT" }) }))
      .rejects.toEqual(code("INVALID_TYPE"));
    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature: await sign(baseEvent, unknown) }))
      .rejects.toEqual(code("UNKNOWN_KEY"));
    expect(jwksRequests).toBe(1);
  });

  it("rejects stale and future signed events", async () => {
    const verifier = createWebhookVerifier(options());
    const stale = { ...baseEvent, occurredAt: new Date(now - 306_000).toISOString() };
    const future = { ...baseEvent, occurredAt: new Date(now + 6_000).toISOString() };

    await expect(verifier.verify({ body: JSON.stringify(stale), signature: await sign(stale) }))
      .rejects.toEqual(code("STALE_EVENT"));
    await expect(verifier.verify({ body: JSON.stringify(future), signature: await sign(future) }))
      .rejects.toEqual(code("FUTURE_EVENT"));
  });

  it("rejects tampered signatures, mismatched bodies, and signed schema-invalid events", async () => {
    const verifier = createWebhookVerifier(options());
    const signature = await sign(baseEvent);
    const parts = signature.split(".");
    parts[2] = `${parts[2]!.slice(0, 5)}${parts[2]![5] === "A" ? "B" : "A"}${parts[2]!.slice(6)}`;
    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature: parts.join(".") }))
      .rejects.toEqual(code("INVALID_SIGNATURE"));

    const mismatched = { ...baseEvent, status: "denied", receipt: undefined };
    await expect(verifier.verify({ body: JSON.stringify(mismatched), signature }))
      .rejects.toEqual(code("BODY_MISMATCH"));

    const invalid = { ...baseEvent, type: "approval.other" };
    await expect(verifier.verify({ body: JSON.stringify(invalid), signature: await sign(invalid) }))
      .rejects.toEqual(code("INVALID_EVENT"));
  });

  it("bounds webhook body and compact signature sizes", async () => {
    const verifier = createWebhookVerifier(options());
    await expect(verifier.verify({ body: "x".repeat(128 * 1024 + 1), signature: "a.b.c" }))
      .rejects.toEqual(code("BODY_TOO_LARGE"));
    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature: `a.${"b".repeat(256 * 1024)}.c` }))
      .rejects.toEqual(code("MALFORMED_SIGNATURE"));
  });

  it("validates optional protected issuer and audience extensions when present", async () => {
    const verifier = createWebhookVerifier(options({
      expectedIssuer: "https://mayi.example",
      expectedAudience: "callback-adapter",
    }));
    const matching = await sign(baseEvent, first, {
      iss: "https://mayi.example",
      aud: ["another-adapter", "callback-adapter"],
    });
    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature: matching }))
      .resolves.toMatchObject({ duplicate: false });

    const wrongIssuer = await sign(baseEvent, first, { iss: "https://other.example" });
    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature: wrongIssuer }))
      .rejects.toEqual(code("ISSUER_MISMATCH"));
    const wrongAudience = await sign(baseEvent, first, { aud: "other-adapter" });
    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature: wrongAudience }))
      .rejects.toEqual(code("AUDIENCE_MISMATCH"));

    const unconfigured = createWebhookVerifier(options());
    await expect(unconfigured.verify({ body: JSON.stringify(baseEvent), signature: matching }))
      .rejects.toEqual(code("ISSUER_MISMATCH"));
  });

  it("returns a safe duplicate result only after complete verification", async () => {
    const processed = new Set<string>();
    let checks = 0;
    const verifier = createWebhookVerifier(options({
      isProcessed: async (eventId) => {
        checks += 1;
        return processed.has(eventId);
      },
    }));
    const signature = await sign(baseEvent);
    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature })).resolves.toEqual({
      duplicate: false,
      event: baseEvent,
    });
    processed.add(baseEvent.id);
    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature })).resolves.toEqual({
      duplicate: true,
      eventId: baseEvent.id,
    });
    expect(checks).toBe(2);

    const tamperedBody = { ...baseEvent, state: "attacker-state" };
    await expect(verifier.verify({ body: JSON.stringify(tamperedBody), signature }))
      .rejects.toEqual(code("BODY_MISMATCH"));
    expect(checks).toBe(2);
  });

  it("fails safely when the duplicate store throws", async () => {
    const secret = "database-credential";
    const verifier = createWebhookVerifier(options({
      isProcessed: async () => { throw new Error(secret); },
    }));
    const error = await verifier.verify({ body: JSON.stringify(baseEvent), signature: await sign(baseEvent) })
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(WebhookVerificationError);
    expect(error).toMatchObject({ code: "DUPLICATE_CHECK_FAILED" });
    expect(`${(error as Error).message} ${JSON.stringify(error)}`).not.toContain(secret);
    expect(Object.keys(error as object)).not.toContain("cause");
  });

  it("rejects malformed or private JWKS documents", async () => {
    const verifier = createWebhookVerifier(options());
    rawJwks = JSON.stringify({ keys: [{ ...first.publicJwk, d: "private-material" }] });
    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature: await sign(baseEvent) }))
      .rejects.toEqual(code("KEY_SET_UNAVAILABLE"));

    rawJwks = JSON.stringify({ keys: [first.publicJwk, first.publicJwk] });
    const secondVerifier = createWebhookVerifier(options());
    await expect(secondVerifier.verify({ body: JSON.stringify(baseEvent), signature: await sign(baseEvent) }))
      .rejects.toEqual(code("KEY_SET_UNAVAILABLE"));
  });

  it("bounds JWKS response size", async () => {
    rawJwks = JSON.stringify({ keys: [], padding: "x".repeat(64 * 1024) });
    const verifier = createWebhookVerifier(options());
    await expect(verifier.verify({ body: JSON.stringify(baseEvent), signature: await sign(baseEvent) }))
      .rejects.toEqual(code("KEY_SET_UNAVAILABLE"));
  });

  it("requires HTTPS except for the explicit loopback-only test opt-in and bounds cache policy", () => {
    expect(() => createWebhookVerifier({
      mayiOrigin: origin,
      maximumEventAgeSeconds: 300,
    })).toThrow(WebhookConfigurationError);
    expect(() => createWebhookVerifier(options({ cacheTtlSeconds: 3_601 })))
      .toThrow(WebhookConfigurationError);
    expect(() => createWebhookVerifier(options({ requestTimeoutMs: 30_001 })))
      .toThrow(WebhookConfigurationError);
    expect(() => createWebhookVerifier(options({ mayiOrigin: "http://example.com" })))
      .toThrow(WebhookConfigurationError);
  });
});
