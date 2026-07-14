import { sha256 } from "@mayi/contracts";

// Cloudflare Workers rejects Web Crypto PBKDF2 requests above 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
}

export async function tokenHash(token: string): Promise<string> { return sha256(token); }

export async function passwordHash(password: string, salt = randomToken(16)): Promise<string> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITERATIONS }, material, 256);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${salt}$${base64url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterations, salt, expected] = encoded.split("$");
  if (algorithm !== "pbkdf2-sha256" || iterations !== String(PBKDF2_ITERATIONS) || !salt || !expected) return false;
  const actual = await passwordHash(password, salt);
  return timingSafeEqual(actual, encoded);
}

export function timingSafeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
