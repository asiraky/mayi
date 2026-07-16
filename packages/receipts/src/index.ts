import { SignJWT, decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import { z } from "zod";
import { canonicalDigest, Id, InputAnswer, InputType, type Action, type Artefact } from "@mayi/contracts";

export const ReceiptClaims = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: Id,
  jti: Id,
  iat: z.number().int(),
  exp: z.number().int(),
  workspace_id: Id,
  agent_id: Id,
  policy_version: z.number().int().positive(),
  action_digest: z.string().regex(/^[a-f0-9]{64}$/),
  artefact_manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
  approver_id: Id,
  enforcement: z.enum(["cooperative", "verified", "consumed"]),
});
export type ReceiptClaims = z.infer<typeof ReceiptClaims>;

export async function signReceipt(claims: ReceiptClaims, privateJwk: JWK, keyId: string): Promise<string> {
  const key = await importJWK(privateJwk, "EdDSA");
  const { iss, aud, sub, jti, iat, exp, ...custom } = claims;
  return new SignJWT(custom)
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: keyId })
    .setIssuer(iss).setAudience(aud).setSubject(sub).setJti(jti)
    .setIssuedAt(iat).setExpirationTime(exp).sign(key);
}

export async function verifyReceipt(token: string, publicJwk: JWK, options: { issuer: string; audience: string; now?: Date }): Promise<ReceiptClaims> {
  const key = await importJWK(publicJwk, "EdDSA");
  const result = await jwtVerify(token, key, {
    issuer: options.issuer,
    audience: options.audience,
    ...(options.now ? { currentDate: options.now } : {}),
    algorithms: ["EdDSA"],
  });
  return ReceiptClaims.parse(result.payload);
}

export const AnswerAttestationClaims = z.object({
  iss: z.string(),
  sub: Id,
  jti: Id,
  iat: z.number().int(),
  workspace_id: Id,
  agent_id: Id,
  input_type: InputType,
  prompt_digest: z.string().regex(/^[a-f0-9]{64}$/),
  answer: InputAnswer,
  answer_digest: z.string().regex(/^[a-f0-9]{64}$/),
  respondent_id: Id,
  answered_at: z.iso.datetime(),
});
export type AnswerAttestationClaims = z.infer<typeof AnswerAttestationClaims>;

export async function signAnswerAttestation(claims: AnswerAttestationClaims, privateJwk: JWK, keyId: string): Promise<string> {
  const key = await importJWK(privateJwk, "EdDSA");
  const { iss, sub, jti, iat, ...custom } = claims;
  return new SignJWT(custom)
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: keyId })
    .setIssuer(iss).setSubject(sub).setJti(jti)
    .setIssuedAt(iat).sign(key);
}

export async function verifyAnswerAttestation(token: string, publicJwks: JWK[], options?: { issuer?: string; now?: Date }): Promise<AnswerAttestationClaims> {
  const kid = decodeProtectedHeader(token).kid;
  const jwk = publicJwks.find((candidate) => candidate.kid === kid);
  if (!jwk) throw new Error("No attestation key matches the token key ID");
  const key = await importJWK(jwk, "EdDSA");
  const result = await jwtVerify(token, key, {
    ...(options?.issuer ? { issuer: options.issuer } : {}),
    ...(options?.now ? { currentDate: options.now } : {}),
    algorithms: ["EdDSA"],
  });
  return AnswerAttestationClaims.parse(result.payload);
}

export async function verifyExactReceipt(token: string, publicJwk: JWK, options: {
  issuer: string; audience: string; action: Action; artefacts: Artefact[]; now?: Date;
}): Promise<ReceiptClaims> {
  const claims = await verifyReceipt(token, publicJwk, options);
  const actionDigest = await canonicalDigest(options.action);
  const manifestDigest = await canonicalDigest([...options.artefacts].sort((a, b) => a.ordinal - b.ordinal).map(({ ordinal, filename, mediaType, size, sha256 }) => ({ ordinal, filename, mediaType, size, sha256 })));
  if (claims.action_digest !== actionDigest || claims.artefact_manifest_digest !== manifestDigest) throw new Error("Receipt does not match the exact action and artefact manifest");
  return claims;
}
