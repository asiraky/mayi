import { defineEventHandler } from "h3";
import { signingKeys } from "../../utils/signer";

export default defineEventHandler(async () => ({ keys: [{ ...(await signingKeys()).publicJwk, use: "sig", alg: "EdDSA" }] }));
