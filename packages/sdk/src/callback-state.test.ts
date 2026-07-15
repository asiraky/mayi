import { MAX_CALLBACK_STATE_LENGTH, type SealedCallbackStateEnvelope } from "@mayi/contracts";
import { describe, expect, it } from "vitest";
import {
  CallbackStateConfigurationError,
  CallbackStateError,
  createCallbackStateCodec,
  type CallbackStateCodecOptions,
} from "./callback-state";

const keyOne = new Uint8Array(32).fill(1);
const keyTwo = new Uint8Array(32).fill(2);
const keyThree = new Uint8Array(32).fill(3);
const start = Date.parse("2026-07-15T00:00:00.000Z");

function encodedKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function options(overrides: Partial<CallbackStateCodecOptions> = {}): CallbackStateCodecOptions {
  return {
    currentKey: { kid: "state-key-1", key: keyOne },
    maximumRetryWindowSeconds: 300,
    now: () => start,
    ...overrides,
  };
}

function errorCode(code: string) {
  return expect.objectContaining({ code });
}

describe("callback-state codec", () => {
  it("round trips JSON payloads with a fresh nonce and ciphertext on every seal", async () => {
    const codec = await createCallbackStateCodec(options({
      currentKey: { kid: "state-key-1", key: encodedKey(keyOne) },
    }));
    const payload = { resume: { callId: "call-42", input: [1, true, null] } };
    const approvalExpiresAt = new Date(start + 60_000);

    const first = await codec.seal(payload, { approvalExpiresAt });
    const second = await codec.seal(payload, { approvalExpiresAt });

    expect(await codec.open(first)).toEqual(payload);
    expect(await codec.open(second)).toEqual(payload);
    const firstEnvelope = JSON.parse(first) as SealedCallbackStateEnvelope;
    const secondEnvelope = JSON.parse(second) as SealedCallbackStateEnvelope;
    expect(firstEnvelope.nonce).not.toBe(secondEnvelope.nonce);
    expect(firstEnvelope.ciphertext).not.toBe(secondEnvelope.ciphertext);
    expect(firstEnvelope.kid).toBe("state-key-1");
  });

  it("aligns state expiry to approval expiry plus the configured retry window", async () => {
    let now = start;
    const codec = await createCallbackStateCodec(options({ now: () => now, maximumRetryWindowSeconds: 300 }));
    const sealed = await codec.seal({ callId: "call-42" }, { approvalExpiresAt: start + 60_000 });

    now = start + 60_000 + 300_000 - 1;
    await expect(codec.open(sealed)).resolves.toEqual({ callId: "call-42" });
    now += 1;
    await expect(codec.open(sealed)).rejects.toEqual(errorCode("EXPIRED"));
  });

  it("opens states sealed by a rotated previous decrypt-only key", async () => {
    const oldCodec = await createCallbackStateCodec(options({ currentKey: { kid: "old", key: keyOne } }));
    const oldState = await oldCodec.seal({ callId: "call-old" }, { approvalExpiresAt: start + 60_000 });
    const rotatedCodec = await createCallbackStateCodec(options({
      currentKey: { kid: "current", key: keyTwo },
      previousKeys: [{ kid: "old", key: keyOne }],
    }));

    await expect(rotatedCodec.open(oldState)).resolves.toEqual({ callId: "call-old" });
    const currentState = await rotatedCodec.seal({ callId: "call-current" }, { approvalExpiresAt: start + 60_000 });
    expect((JSON.parse(currentState) as SealedCallbackStateEnvelope).kid).toBe("current");
    await expect(oldCodec.open(currentState)).rejects.toEqual(errorCode("UNKNOWN_KEY"));
  });

  it("fails closed for ciphertext, nonce, and authenticated metadata tampering", async () => {
    const codec = await createCallbackStateCodec(options());
    const sealed = await codec.seal({ credential: "never-expose-this" }, { approvalExpiresAt: start + 60_000 });
    const envelope = JSON.parse(sealed) as SealedCallbackStateEnvelope;
    const tamperedCiphertext = {
      ...envelope,
      ciphertext: `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`,
    };
    const tamperedNonce = {
      ...envelope,
      nonce: `${envelope.nonce[0] === "A" ? "B" : "A"}${envelope.nonce.slice(1)}`,
    };
    const tamperedKid = { ...envelope, kid: "state-key-2" };

    await expect(codec.open(JSON.stringify(tamperedCiphertext))).rejects.toEqual(errorCode("INVALID_STATE"));
    await expect(codec.open(JSON.stringify(tamperedNonce))).rejects.toEqual(errorCode("INVALID_STATE"));
    await expect(codec.open(JSON.stringify(tamperedKid))).rejects.toEqual(errorCode("UNKNOWN_KEY"));
  });

  it("uses the same non-oracular failure for wrong key material and tampering", async () => {
    const codec = await createCallbackStateCodec(options());
    const wrongCodec = await createCallbackStateCodec(options({
      currentKey: { kid: "state-key-1", key: keyThree },
    }));
    const sealed = await codec.seal({ secret: "callback-secret" }, { approvalExpiresAt: start + 60_000 });
    const envelope = JSON.parse(sealed) as SealedCallbackStateEnvelope;
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}`;

    const wrongKeyError = await wrongCodec.open(sealed).catch((error) => error);
    const tamperError = await codec.open(JSON.stringify(envelope)).catch((error) => error);
    expect(wrongKeyError).toMatchObject({ name: "CallbackStateError", code: "INVALID_STATE" });
    expect(tamperError).toMatchObject({ name: "CallbackStateError", code: "INVALID_STATE" });
    expect((wrongKeyError as Error).message).toBe((tamperError as Error).message);
    expect(JSON.stringify(wrongKeyError)).not.toContain("callback-secret");
  });

  it("rejects unknown keys, unsupported versions, malformed envelopes, and oversize states", async () => {
    const codec = await createCallbackStateCodec(options());
    const sealed = await codec.seal({ ok: true }, { approvalExpiresAt: start + 60_000 });
    const envelope = JSON.parse(sealed) as SealedCallbackStateEnvelope;

    await expect(codec.open(JSON.stringify({ ...envelope, kid: "unknown" })))
      .rejects.toEqual(errorCode("UNKNOWN_KEY"));
    await expect(codec.open(JSON.stringify({ ...envelope, version: 2 })))
      .rejects.toEqual(errorCode("UNSUPPORTED_VERSION"));
    await expect(codec.open("not-json")).rejects.toEqual(errorCode("INVALID_STATE"));
    await expect(codec.open(JSON.stringify({ ...envelope, extra: true })))
      .rejects.toEqual(errorCode("INVALID_STATE"));
    await expect(codec.open("x".repeat(MAX_CALLBACK_STATE_LENGTH + 1)))
      .rejects.toEqual(errorCode("STATE_TOO_LARGE"));
    await expect(codec.seal("x".repeat(MAX_CALLBACK_STATE_LENGTH), { approvalExpiresAt: start + 60_000 }))
      .rejects.toEqual(errorCode("STATE_TOO_LARGE"));
  });

  it("rejects expired approval input before encrypting", async () => {
    const codec = await createCallbackStateCodec(options());
    await expect(codec.seal({ ok: true }, { approvalExpiresAt: start }))
      .rejects.toEqual(errorCode("INVALID_EXPIRY"));
    await expect(codec.seal({ ok: true }, { approvalExpiresAt: "invalid" }))
      .rejects.toEqual(errorCode("INVALID_EXPIRY"));
  });

  it("requires valid stable 32-byte keys, unique kids, and an explicit retry window", async () => {
    await expect(createCallbackStateCodec(options({ currentKey: { kid: "key", key: new Uint8Array(31) } })))
      .rejects.toBeInstanceOf(CallbackStateConfigurationError);
    await expect(createCallbackStateCodec(options({ currentKey: { kid: "key", key: `${encodedKey(keyOne)}=` } })))
      .rejects.toEqual(errorCode("INVALID_CURRENT_KEY"));
    await expect(createCallbackStateCodec(options({
      currentKey: { kid: "same", key: keyOne },
      previousKeys: [{ kid: "same", key: keyTwo }],
    }))).rejects.toEqual(errorCode("DUPLICATE_KEY_ID"));
    await expect(createCallbackStateCodec({
      currentKey: { kid: "key", key: keyOne },
    } as CallbackStateCodecOptions)).rejects.toEqual(errorCode("INVALID_RETRY_WINDOW"));
    await expect(createCallbackStateCodec({
      maximumRetryWindowSeconds: 300,
    } as CallbackStateCodecOptions)).rejects.toEqual(errorCode("INVALID_CURRENT_KEY"));
  });

  it("uses typed secret-safe errors", async () => {
    const codec = await createCallbackStateCodec(options());
    const secret = "decrypted-secret-value";
    const state = await codec.seal({ secret }, { approvalExpiresAt: start + 60_000 });
    const error = await codec.open(`${state}x`).catch((cause) => cause);
    expect(error).toBeInstanceOf(CallbackStateError);
    expect(`${(error as Error).message} ${JSON.stringify(error)}`).not.toContain(secret);
    expect(Object.keys(error as object)).not.toContain("cause");
  });
});
