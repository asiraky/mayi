import { canonicalize } from "@mayi/contracts";
import { CompactSign, importJWK } from "jose";
import { createError } from "h3";
import { signingKeys } from "./signer";

function isPrivateIp(address: string): boolean {
  if (address === "::1" || address === "0:0:0:0:0:0:0:1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168);
}

export async function validateOutboundUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw createError({ statusCode: 422, statusMessage: "Webhook must use HTTPS on the default port without credentials" });
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal") || isPrivateIp(hostname)) throw createError({ statusCode: 422, statusMessage: "Webhook host is not public" });
  try {
    const dns = await import("node:dns/promises");
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((item) => isPrivateIp(item.address))) throw new Error("private address");
  } catch (error) {
    if ((error as { code?: string }).code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw createError({ statusCode: 422, statusMessage: "Webhook DNS does not resolve exclusively to public addresses" });
  }
  return url;
}

export async function signWebhook(payload: unknown): Promise<string> {
  const keys = await signingKeys();
  const key = await importJWK(keys.privateJwk, "EdDSA");
  return new CompactSign(new TextEncoder().encode(canonicalize(payload)))
    .setProtectedHeader({ alg: "EdDSA", kid: keys.kid, typ: "mayi-webhook+jws" }).sign(key);
}
