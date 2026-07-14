import { exportJWK, generateKeyPair } from "jose";

const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
const privateJwk = await exportJWK(privateKey);
const publicJwk = await exportJWK(publicKey);
const kid = crypto.randomUUID();
privateJwk.kid = publicJwk.kid = kid;
console.log(`RECEIPT_PRIVATE_JWK='${JSON.stringify(privateJwk)}'`);
console.log(`RECEIPT_PUBLIC_JWK='${JSON.stringify(publicJwk)}'`);
