import { exportJWK, generateKeyPair } from "jose";
import { createId } from "@mayi/contracts";
import { describe, expect, it } from "vitest";
import { signReceipt, verifyReceipt } from "./index";

it("binds and verifies an exact receipt", async () => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  const publicJwk = await exportJWK(pair.publicKey);
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://mayi.test", aud: "executor", sub: createId(), jti: createId(), iat: now, exp: now + 60,
    workspace_id: createId(), agent_id: createId(), policy_version: 1,
    action_digest: "a".repeat(64), artefact_manifest_digest: "b".repeat(64), approver_id: createId(), enforcement: "verified" as const,
  };
  const token = await signReceipt(claims, privateJwk, "test");
  expect((await verifyReceipt(token, publicJwk, { issuer: claims.iss, audience: "executor" })).action_digest).toBe(claims.action_digest);
  await expect(verifyReceipt(token, publicJwk, { issuer: claims.iss, audience: "other" })).rejects.toThrow();
});
