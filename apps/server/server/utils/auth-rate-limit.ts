import { sha256 } from "@mayi/contracts";
import { createError, getHeader, getRequestIP, type H3Event } from "h3";
import { database } from "./runtime";

const HEADER_PATTERN = /^[a-z0-9-]{1,100}$/;

function normalizeAddress(value: string | undefined): string | undefined {
  const address = value?.trim().toLowerCase();
  if (!address || address.length > 128 || address.includes(",") || /\s/.test(address)) return undefined;
  return address;
}

export function authenticationClientAddress(
  event: H3Event,
  env: Record<string, string | undefined> = process.env,
  development = import.meta.dev,
): string {
  const trustedHeader = (env.AUTH_TRUSTED_IP_HEADER ?? (env.VERCEL === "1" ? "x-vercel-forwarded-for" : undefined))
    ?.trim().toLowerCase();
  if (trustedHeader) {
    if (!HEADER_PATTERN.test(trustedHeader)) {
      throw createError({ statusCode: 500, statusMessage: "Authentication IP header configuration is invalid" });
    }
    const trusted = normalizeAddress(getHeader(event, trustedHeader));
    if (trusted) return trusted;
    const direct = normalizeAddress(getRequestIP(event));
    if (direct) return direct;
    throw createError({ statusCode: 400, statusMessage: "Authentication source IP is unavailable" });
  }
  const direct = normalizeAddress(getRequestIP(event));
  if (direct) return direct;
  if (development) {
    const forwarded = normalizeAddress(getHeader(event, "x-forwarded-for"));
    if (forwarded) return forwarded;
  }
  throw createError({ statusCode: 400, statusMessage: "Authentication source IP is unavailable" });
}

export async function recordAuthenticationAttempt(identity: string, maximumPerHour: number): Promise<string> {
  if (!Number.isInteger(maximumPerHour) || maximumPerHour < 1 || maximumPerHour > 30) {
    throw new TypeError("Authentication attempt limit is invalid");
  }
  const identityHash = await sha256(identity);
  const [row] = await database().sql`
    insert into oauth_registration_attempts (identity_hash, window_started_at, attempts, last_attempt_at)
    values (${identityHash}, now(), 1, now())
    on conflict (identity_hash) do update set
      attempts = case
        when oauth_registration_attempts.window_started_at <= now() - interval '1 hour' then 1
        else least(oauth_registration_attempts.attempts + 1, 31)
      end,
      window_started_at = case
        when oauth_registration_attempts.window_started_at <= now() - interval '1 hour' then now()
        else oauth_registration_attempts.window_started_at
      end,
      last_attempt_at = now()
    returning attempts
  `;
  if (Number(row!.attempts) > maximumPerHour) {
    throw createError({ statusCode: 429, statusMessage: "Too many authentication attempts; try again later" });
  }
  return identityHash;
}

export async function clearAuthenticationAttempts(identityHashes: string[]): Promise<void> {
  if (!identityHashes.length) return;
  await database().sql`delete from oauth_registration_attempts where identity_hash in ${database().sql(identityHashes)}`;
}
