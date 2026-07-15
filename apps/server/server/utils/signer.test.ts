import { afterEach, describe, expect, it, vi } from "vitest";
import jwksHandler from "../routes/.well-known/jwks.json.get";
import { signingKeys } from "./signer";

const X = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const D = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function publicJwk(kid: string) {
  return { kty: "OKP", crv: "Ed25519", x: X, kid };
}

function configure(previous: unknown[] = [], current = publicJwk("current")) {
  vi.stubEnv("RECEIPT_PRIVATE_JWK", JSON.stringify({ ...current, d: D }));
  vi.stubEnv("RECEIPT_PUBLIC_JWK", JSON.stringify(current));
  vi.stubEnv("RECEIPT_PREVIOUS_PUBLIC_JWKS", JSON.stringify(previous));
}

function resetSigner() {
  delete (globalThis as typeof globalThis & { __mayiKeys?: unknown }).__mayiKeys;
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetSigner();
});

describe("receipt signing-key rotation", () => {
  it("keeps the active key first while retaining previous public keys", async () => {
    configure([publicJwk("previous-1"), { ...publicJwk("previous-2"), alg: "EdDSA", use: "sig" }]);

    const keys = await signingKeys();

    expect(keys.kid).toBe("current");
    expect(keys.publicJwk).toBe(keys.publicJwks[0]);
    expect(keys.publicJwks.map((key) => key.kid)).toEqual(["current", "previous-1", "previous-2"]);
  });

  it("preserves the single-key configuration", async () => {
    configure();

    const keys = await signingKeys();

    expect(keys.publicJwks).toEqual([keys.publicJwk]);
  });

  it("publishes the active and retained keys in the JWKS response", async () => {
    configure([publicJwk("previous")]);

    const response = await jwksHandler({} as Parameters<typeof jwksHandler>[0]);

    expect(response).toMatchObject({
      keys: [
        { kid: "current", alg: "EdDSA", use: "sig" },
        { kid: "previous", alg: "EdDSA", use: "sig" },
      ],
    });
  });

  it("bounds the published JWKS to 16 keys", async () => {
    configure(Array.from({ length: 16 }, (_, index) => publicJwk(`previous-${index}`)));

    await expect(signingKeys()).rejects.toThrow("cannot contain more than 16 keys");
  });

  it("requires unique key IDs", async () => {
    configure([publicJwk("current")]);

    await expect(signingKeys()).rejects.toThrow("key IDs must be unique");
  });

  it.each([
    ["invalid key IDs", { ...publicJwk("previous"), kid: "not valid" }],
    ["non-Ed25519 keys", { ...publicJwk("previous"), crv: "X25519" }],
    ["malformed public keys", { ...publicJwk("previous"), x: "short" }],
    ["private keys", { ...publicJwk("previous"), d: D }],
    ["non-signing keys", { ...publicJwk("previous"), use: "enc" }],
    ["keys with signing operations", { ...publicJwk("previous"), key_ops: ["sign"] }],
  ])("rejects %s in the retained public keys", async (_description, previous) => {
    configure([previous]);

    await expect(signingKeys()).rejects.toThrow("must contain a public Ed25519 JWK");
  });

  it("requires retained keys to be a JSON array", async () => {
    configure();
    vi.stubEnv("RECEIPT_PREVIOUS_PUBLIC_JWKS", JSON.stringify({ keys: [publicJwk("previous")] }));

    await expect(signingKeys()).rejects.toThrow("must be a JSON array");
  });
});
