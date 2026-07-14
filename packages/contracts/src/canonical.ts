export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function serialize(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON forbids non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(value[key]!)}`).join(",")}}`;
}

export function canonicalize(value: unknown): string {
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("Value is not valid JSON");
  }
  return serialize(value as Json);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const source = Uint8Array.from(bytes).buffer;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", source)));
}

export async function canonicalDigest(value: unknown): Promise<string> {
  return sha256(canonicalize(value));
}
