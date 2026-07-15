import { exportJWK, generateKeyPair, type JWK } from "jose";
import { getConfig } from "./config";

const KID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_PUBLIC_KEYS = 16;

type PublicSigningJwk = JWK & { kid: string; kty: "OKP"; crv: "Ed25519"; x: string };
type KeySet = { privateJwk: JWK; publicJwk: PublicSigningJwk; publicJwks: PublicSigningJwk[]; kid: string };
const state = globalThis as typeof globalThis & { __mayiKeys?: Promise<KeySet> };

function publicSigningJwk(value: unknown, source: string): PublicSigningJwk {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must contain a public Ed25519 JWK`);
  }

  const key = value as Record<string, unknown>;
  if (
    key.kty !== "OKP"
    || key.crv !== "Ed25519"
    || typeof key.x !== "string"
    || typeof key.kid !== "string"
    || !KID_PATTERN.test(key.kid)
    || "d" in key
    || (key.alg !== undefined && key.alg !== "EdDSA")
    || (key.use !== undefined && key.use !== "sig")
  ) {
    throw new Error(`${source} must contain a public Ed25519 JWK with a valid kid`);
  }
  if (key.key_ops !== undefined && (
    !Array.isArray(key.key_ops)
    || key.key_ops.length !== 1
    || key.key_ops[0] !== "verify"
  )) {
    throw new Error(`${source} must contain a public Ed25519 JWK with a valid kid`);
  }
  try {
    const decoded = atob(key.x.replace(/-/g, "+").replace(/_/g, "/") + "=");
    const canonical = btoa(decoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    if (decoded.length !== 32 || canonical !== key.x) throw new Error("invalid public key");
  } catch {
    throw new Error(`${source} must contain a public Ed25519 JWK with a valid kid`);
  }
  return value as PublicSigningJwk;
}

function retainedPublicJwks(raw: string | undefined): unknown[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("RECEIPT_PREVIOUS_PUBLIC_JWKS must be a JSON array");
  return parsed;
}

function publicKeySet(current: JWK, rawPrevious: string | undefined): PublicSigningJwk[] {
  const values = [current, ...retainedPublicJwks(rawPrevious)];
  if (values.length > MAX_PUBLIC_KEYS) {
    throw new Error(`Receipt JWKS cannot contain more than ${MAX_PUBLIC_KEYS} keys`);
  }

  const keys = values.map((value, index) => publicSigningJwk(
    value,
    index === 0 ? "RECEIPT_PUBLIC_JWK" : `RECEIPT_PREVIOUS_PUBLIC_JWKS[${index - 1}]`,
  ));
  if (new Set(keys.map((key) => key.kid)).size !== keys.length) {
    throw new Error("Receipt JWKS key IDs must be unique");
  }
  return keys;
}

export function signingKeys(): Promise<KeySet> {
  return state.__mayiKeys ??= (async () => {
    const config = getConfig();
    if (config.receiptPrivateJwk && config.receiptPublicJwk) {
      const privateJwk = JSON.parse(config.receiptPrivateJwk) as JWK;
      const publicJwk = JSON.parse(config.receiptPublicJwk) as JWK;
      const kid = String(publicJwk.kid ?? privateJwk.kid ?? "primary");
      const publicJwks = publicKeySet({ ...publicJwk, kid }, config.receiptPreviousPublicJwks);
      return { privateJwk, publicJwk: publicJwks[0]!, publicJwks, kid };
    }
    if (process.env.NODE_ENV === "production") throw new Error("Receipt signing keys are required in production");
    const pair = await generateKeyPair("EdDSA", { extractable: true });
    const privateJwk = await exportJWK(pair.privateKey);
    const publicJwk = await exportJWK(pair.publicKey);
    const kid = "ephemeral-development-key";
    privateJwk.kid = publicJwk.kid = kid;
    const publicJwks = publicKeySet(publicJwk, config.receiptPreviousPublicJwks);
    return { privateJwk, publicJwk: publicJwks[0]!, publicJwks, kid };
  })();
}
