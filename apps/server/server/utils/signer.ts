import { exportJWK, generateKeyPair, type JWK } from "jose";
import { getConfig } from "./config";

type KeySet = { privateJwk: JWK; publicJwk: JWK; kid: string };
const state = globalThis as typeof globalThis & { __mayiKeys?: Promise<KeySet> };

export function signingKeys(): Promise<KeySet> {
  return state.__mayiKeys ??= (async () => {
    const config = getConfig();
    if (config.receiptPrivateJwk && config.receiptPublicJwk) {
      const privateJwk = JSON.parse(config.receiptPrivateJwk) as JWK;
      const publicJwk = JSON.parse(config.receiptPublicJwk) as JWK;
      const kid = String(publicJwk.kid ?? privateJwk.kid ?? "primary");
      return { privateJwk, publicJwk: { ...publicJwk, kid }, kid };
    }
    if (process.env.NODE_ENV === "production") throw new Error("Receipt signing keys are required in production");
    const pair = await generateKeyPair("EdDSA", { extractable: true });
    const privateJwk = await exportJWK(pair.privateKey);
    const publicJwk = await exportJWK(pair.publicKey);
    const kid = "ephemeral-development-key";
    privateJwk.kid = publicJwk.kid = kid;
    return { privateJwk, publicJwk, kid };
  })();
}
