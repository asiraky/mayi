import { createId } from "@mayi/contracts";
import type { DatabaseSql } from "@mayi/db";
import { createError, defineEventHandler, getHeader, getRequestIP, type H3Event } from "h3";
import { z } from "zod";
import { tokenHash } from "../../utils/crypto";
import { readBoundedBody } from "../../utils/http";
import {
  validatePublicHttpsUrl,
  type ValidatePublicHttpsUrlOptions,
} from "../../utils/public-url";
import { database } from "../../utils/runtime";

export const OAUTH_REGISTRATION_LIMITS = {
  bodyBytes: 32 * 1024,
  clientNameChars: 100,
  redirectUris: 5,
  approvalCallbackUris: 10,
  uriChars: 2048,
  attemptsPerIpPerHour: 30,
  successfulPerIpPerHour: 10,
  concurrentDnsValidations: 16,
} as const;

const Uri = z.string().min(1).max(OAUTH_REGISTRATION_LIMITS.uriChars);
const Registration = z.object({
  client_name: z.string().min(1).max(OAUTH_REGISTRATION_LIMITS.clientNameChars),
  redirect_uris: z.array(Uri).min(1).max(OAUTH_REGISTRATION_LIMITS.redirectUris),
  approval_callback_uris: z.array(Uri).min(1).max(OAUTH_REGISTRATION_LIMITS.approvalCallbackUris),
}).strict().superRefine((input, context) => {
  for (const [field, values] of [
    ["redirect_uris", input.redirect_uris],
    ["approval_callback_uris", input.approval_callback_uris],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", path: [field], message: `${field} must not contain duplicate exact URIs` });
    }
  }
});

export type OAuthRegistrationInput = z.infer<typeof Registration>;

function bodyBytes(raw: string | Uint8Array): number {
  return typeof raw === "string" ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
}

export function validateRedirectUri(value: string, production = process.env.NODE_ENV === "production"): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw createError({ statusCode: 422, statusMessage: "Redirect URI is invalid" });
  }

  if (url.username || url.password || url.hash) {
    throw createError({ statusCode: 422, statusMessage: "Redirect URIs must not contain credentials or fragments" });
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const developmentLoopback = !production && url.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(hostname);
  const defaultHttps = url.protocol === "https:" && !url.port;
  if (!defaultHttps && !developmentLoopback) {
    throw createError({
      statusCode: 422,
      statusMessage: production
        ? "Redirect URIs must use HTTPS on the default port"
        : "Redirect URIs must use HTTPS on the default port (loopback HTTP is allowed in development)",
    });
  }
}

export async function parseAndValidateRegistration(
  raw: string | Uint8Array | null | undefined,
  options: ValidatePublicHttpsUrlOptions & { production?: boolean } = {},
): Promise<OAuthRegistrationInput> {
  if (raw == null) throw createError({ statusCode: 400, statusMessage: "Registration body is required" });
  if (bodyBytes(raw) > OAUTH_REGISTRATION_LIMITS.bodyBytes) {
    throw createError({ statusCode: 413, statusMessage: "Registration body exceeds 32 KiB" });
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Registration body must be valid JSON" });
  }

  const result = Registration.safeParse(decoded);
  if (!result.success) {
    throw createError({ statusCode: 422, statusMessage: "Invalid OAuth client registration", data: result.error.flatten() });
  }

  for (const value of result.data.redirect_uris) validateRedirectUri(value, options.production);
  for (const value of result.data.approval_callback_uris) {
    try {
      await validatePublicHttpsUrl(value, options);
    } catch (error) {
      throw createError({
        statusCode: 422,
        statusMessage: error instanceof Error ? error.message : "Approval callback URL is not a public HTTPS URL",
      });
    }
  }
  return result.data;
}

export function assertRegistrationRateAllowed(successfulRegistrations: number): void {
  if (successfulRegistrations >= OAUTH_REGISTRATION_LIMITS.successfulPerIpPerHour) {
    throw createError({ statusCode: 429, statusMessage: "OAuth client registration rate limit exceeded" });
  }
}

export class RegistrationValidationGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError("maximum is invalid");
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

const runtimeState = globalThis as typeof globalThis & {
  __mayiOAuthRegistrationValidationGate?: RegistrationValidationGate;
};

function validationGate(): RegistrationValidationGate {
  return runtimeState.__mayiOAuthRegistrationValidationGate ??= new RegistrationValidationGate(
    OAUTH_REGISTRATION_LIMITS.concurrentDnsValidations,
  );
}

const TRUSTED_IP_HEADER_PATTERN = /^[a-z0-9-]{1,100}$/;

function validClientAddress(value: string): boolean {
  if (value.length > 128 || value.includes(",") || /\s/.test(value)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  if (!value.includes(":")) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 0;
  } catch {
    return false;
  }
}

export function normalizeRegistrationClientAddress(value: string | undefined): string {
  const address = value?.trim();
  if (!address || !validClientAddress(address)) {
    throw createError({ statusCode: 400, statusMessage: "Registration source IP is unavailable" });
  }
  return address.toLowerCase();
}

export function registrationClientAddress(
  event: H3Event,
  env: Record<string, string | undefined> = process.env,
  development = import.meta.dev,
): string {
  const configuredHeader = (
    env.OAUTH_REGISTRATION_TRUSTED_IP_HEADER
    ?? (env.VERCEL === "1" ? "x-vercel-forwarded-for" : undefined)
  )?.trim().toLowerCase();
  if (configuredHeader) {
    if (!TRUSTED_IP_HEADER_PATTERN.test(configuredHeader)) {
      throw createError({ statusCode: 500, statusMessage: "OAuth registration IP header configuration is invalid" });
    }
    // The configured proxy must overwrite this header with one address. Lists are
    // deliberately rejected rather than guessing which hop is trustworthy.
    const trustedAddress = getHeader(event, configuredHeader);
    if (trustedAddress) return normalizeRegistrationClientAddress(trustedAddress);
    // The Docker full profile also exposes the app on loopback for direct local
    // use. If that request did not traverse the proxy, bind its limit to the
    // socket peer instead of rejecting an otherwise valid registration.
    const directAddress = getRequestIP(event);
    if (directAddress) return normalizeRegistrationClientAddress(directAddress);
    return normalizeRegistrationClientAddress(undefined);
  }
  const directAddress = getRequestIP(event);
  if (directAddress) return normalizeRegistrationClientAddress(directAddress);
  // Nitro's development proxy does not expose its internal socket address to H3,
  // but it does append the loopback client to X-Forwarded-For. This fallback is
  // development-only so a production caller can never choose its rate-limit key.
  if (development) {
    return normalizeRegistrationClientAddress(getHeader(event, "x-forwarded-for"));
  }
  return normalizeRegistrationClientAddress(undefined);
}

export function assertRegistrationAttemptAllowed(attempts: number): void {
  if (attempts > OAUTH_REGISTRATION_LIMITS.attemptsPerIpPerHour) {
    throw createError({ statusCode: 429, statusMessage: "OAuth client registration attempt limit exceeded" });
  }
}

export async function recordRegistrationAttempt(
  identityHash: string,
  sql: DatabaseSql = database().sql,
): Promise<number> {
  const deniedCount = OAUTH_REGISTRATION_LIMITS.attemptsPerIpPerHour + 1;
  const [recorded] = await sql`
    with pruned as (
      delete from oauth_registration_attempts
      where identity_hash in (
        select identity_hash from oauth_registration_attempts
        where last_attempt_at < now() - interval '24 hours'
          and identity_hash <> ${identityHash}
        order by last_attempt_at
        limit 25
      )
    )
    insert into oauth_registration_attempts (identity_hash, window_started_at, attempts, last_attempt_at)
    values (${identityHash}, now(), 1, now())
    on conflict (identity_hash) do update set
      attempts = case
        when oauth_registration_attempts.window_started_at <= now() - interval '1 hour' then 1
        else least(oauth_registration_attempts.attempts + 1, ${deniedCount})
      end,
      window_started_at = case
        when oauth_registration_attempts.window_started_at <= now() - interval '1 hour' then now()
        else oauth_registration_attempts.window_started_at
      end,
      last_attempt_at = now()
    returning attempts
  `;
  return Number(recorded!.attempts);
}

async function insertRegistration(input: OAuthRegistrationInput, registrationIpHash: string): Promise<string> {
  const id = createId();
  return database().sql.begin("isolation level serializable", async (sql) => {
    // A per-source transaction lock makes the count-and-insert atomic across all
    // application processes without retaining the source IP itself.
    await sql`select pg_advisory_xact_lock(hashtextextended(${registrationIpHash}, 0))`;
    const [rate] = await sql`
      select count(*)::integer as count from oauth_clients
      where registration_ip_hash = ${registrationIpHash} and created_at >= now() - interval '1 hour'
    `;
    assertRegistrationRateAllowed(Number(rate?.count ?? 0));
    await sql`
      insert into oauth_clients (id, name, redirect_uris, approval_callback_uris, registration_ip_hash)
      values (${id}, ${input.client_name}, ${input.redirect_uris}, ${input.approval_callback_uris}, ${registrationIpHash})
    `;
    return id;
  });
}

export default defineEventHandler(async (event) => {
  const sourceIp = registrationClientAddress(event);
  const registrationIpHash = await tokenHash(sourceIp);
  // Attempts are consumed before body parsing or callback DNS validation, so
  // malformed and unresolvable registrations cannot bypass resource limits.
  assertRegistrationAttemptAllowed(await recordRegistrationAttempt(registrationIpHash));
  const raw = await readBoundedBody(
    event,
    OAUTH_REGISTRATION_LIMITS.bodyBytes,
    "Registration body exceeds 32 KiB",
  );
  const input = await validationGate().run(() => parseAndValidateRegistration(raw));
  const id = await insertRegistration(input, registrationIpHash);
  return {
    client_id: id,
    client_name: input.client_name,
    redirect_uris: input.redirect_uris,
    approval_callback_uris: input.approval_callback_uris,
    token_endpoint_auth_method: "none",
  };
});
