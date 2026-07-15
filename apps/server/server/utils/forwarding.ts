import { canonicalize } from "@mayi/contracts";
import { CompactSign, importJWK } from "jose";
import { createError } from "h3";
import { validatePublicHttpsUrl } from "./public-url";
import { signingKeys } from "./signer";

export async function validateOutboundUrl(value: string): Promise<URL> {
  try {
    return (await validatePublicHttpsUrl(value)).url;
  } catch (error) {
    throw createError({
      statusCode: 422,
      statusMessage: error instanceof Error ? error.message.replace("Callback", "Webhook") : "Webhook URL is not public",
    });
  }
}

export async function signWebhook(payload: unknown): Promise<string> {
  const keys = await signingKeys();
  const key = await importJWK(keys.privateJwk, "EdDSA");
  return new CompactSign(new TextEncoder().encode(canonicalize(payload)))
    .setProtectedHeader({ alg: "EdDSA", kid: keys.kid, typ: "mayi-webhook+jws" }).sign(key);
}
