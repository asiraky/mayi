import { defineEventHandler } from "h3";
import { signingKeys } from "../../utils/signer";

export default defineEventHandler(async () => ({
  keys: (await signingKeys()).publicJwks.map((key) => ({ ...key, use: "sig", alg: "EdDSA" })),
}));
