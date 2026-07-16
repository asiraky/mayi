import { exportJWK, generateKeyPair } from "jose";
import { canonicalDigest, createId } from "@mayi/contracts";
import { expect, it } from "vitest";
import { signAnswerAttestation, signReceipt, verifyAnswerAttestation, verifyReceipt } from "./index";

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

async function attestationFixture() {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test" };
  const answer = { optionId: "proceed" };
  const claims = {
    iss: "https://mayi.test", sub: createId(), jti: createId(), iat: Math.floor(Date.now() / 1000),
    workspace_id: createId(), agent_id: createId(), input_type: "select" as const,
    prompt_digest: await canonicalDigest({ prompt: "Which environment?" }),
    answer, answer_digest: await canonicalDigest(answer),
    respondent_id: createId(), answered_at: "2026-07-15T00:00:00.000Z",
  };
  return { privateJwk, publicJwk, claims };
}

it("signs and verifies an answer attestation without an expiry", async () => {
  const { privateJwk, publicJwk, claims } = await attestationFixture();
  const token = await signAnswerAttestation(claims, privateJwk, "test");
  const verified = await verifyAnswerAttestation(token, [publicJwk], { issuer: claims.iss });
  expect(verified).toEqual(claims);
  expect(verified).not.toHaveProperty("exp");
  const farFuture = new Date("2126-07-15T00:00:00.000Z");
  expect((await verifyAnswerAttestation(token, [publicJwk], { now: farFuture })).answer_digest).toBe(claims.answer_digest);
});

it("rejects a tampered attestation", async () => {
  const { privateJwk, publicJwk, claims } = await attestationFixture();
  const token = await signAnswerAttestation(claims, privateJwk, "test");
  const [header, payload, signature] = token.split(".");
  const forged = JSON.parse(Buffer.from(payload!, "base64url").toString());
  forged.answer = { optionId: "abort" };
  const tampered = [header, Buffer.from(JSON.stringify(forged)).toString("base64url"), signature].join(".");
  await expect(verifyAnswerAttestation(tampered, [publicJwk])).rejects.toThrow();
});

it("rejects an attestation signed by a different key", async () => {
  const { privateJwk, claims } = await attestationFixture();
  const token = await signAnswerAttestation(claims, privateJwk, "test");
  const otherPair = await generateKeyPair("EdDSA", { extractable: true });
  const otherPublicJwk = { ...(await exportJWK(otherPair.publicKey)), kid: "test" };
  await expect(verifyAnswerAttestation(token, [otherPublicJwk])).rejects.toThrow();
  await expect(verifyAnswerAttestation(token, [{ ...otherPublicJwk, kid: "unknown" }])).rejects.toThrow(/No attestation key/);
});
