import {
  ApprovalResolvedEvent as ApprovalResolvedEventSchema,
  canonicalize,
  type ApprovalResolvedEvent,
} from "@mayi/contracts";
import { compactVerify, decodeProtectedHeader, importJWK, type JWK } from "jose";

export const MAYI_JWKS_PATH = "/.well-known/jwks.json";
export const MAYI_SIGNATURE_HEADER = "x-mayi-signature";

const WEBHOOK_JWS_TYPE = "mayi-webhook+jws";
const MAX_WEBHOOK_BODY_BYTES = 128 * 1024;
const MAX_SIGNATURE_BYTES = 256 * 1024;
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_JWKS_KEYS = 16;
const MAX_CACHE_TTL_SECONDS = 60 * 60;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_EVENT_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAX_CLOCK_TOLERANCE_SECONDS = 5 * 60;
const UNKNOWN_KEY_REFRESH_COOLDOWN_MS = 60 * 1_000;
const KID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export type WebhookVerifierFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type IsWebhookEventProcessed = (eventId: string) => boolean | Promise<boolean>;

export interface WebhookVerifierOptions {
  mayiOrigin: string;
  maximumEventAgeSeconds: number;
  expectedIssuer?: string;
  expectedAudience?: string;
  cacheTtlSeconds?: number;
  requestTimeoutMs?: number;
  clockToleranceSeconds?: number;
  fetch?: WebhookVerifierFetch;
  isProcessed?: IsWebhookEventProcessed;
  now?: () => number;
  dangerouslyAllowInsecureHttpForTests?: boolean;
}

export interface VerifyWebhookInput {
  body: string | Uint8Array;
  signature: string | null | undefined;
}

export type WebhookVerificationResult =
  | { duplicate: false; event: ApprovalResolvedEvent }
  | { duplicate: true; eventId: string };

export interface WebhookVerifier {
  verify(input: VerifyWebhookInput): Promise<WebhookVerificationResult>;
}

export type WebhookConfigurationErrorCode =
  | "INVALID_ORIGIN"
  | "INSECURE_ORIGIN"
  | "INVALID_MAXIMUM_EVENT_AGE"
  | "INVALID_CACHE_TTL"
  | "INVALID_REQUEST_TIMEOUT"
  | "INVALID_CLOCK_TOLERANCE"
  | "INVALID_EXPECTED_ISSUER"
  | "INVALID_EXPECTED_AUDIENCE"
  | "FETCH_UNAVAILABLE";

export class WebhookConfigurationError extends Error {
  readonly code: WebhookConfigurationErrorCode;

  constructor(code: WebhookConfigurationErrorCode) {
    const messages: Record<WebhookConfigurationErrorCode, string> = {
      INVALID_ORIGIN: "The Mayi JWKS origin is invalid",
      INSECURE_ORIGIN: "The Mayi JWKS origin must use HTTPS",
      INVALID_MAXIMUM_EVENT_AGE: "The webhook maximum event age is invalid",
      INVALID_CACHE_TTL: "The JWKS cache TTL is invalid",
      INVALID_REQUEST_TIMEOUT: "The JWKS request timeout is invalid",
      INVALID_CLOCK_TOLERANCE: "The webhook clock tolerance is invalid",
      INVALID_EXPECTED_ISSUER: "The expected webhook issuer is invalid",
      INVALID_EXPECTED_AUDIENCE: "The expected webhook audience is invalid",
      FETCH_UNAVAILABLE: "A fetch implementation is required in this runtime",
    };
    super(messages[code]);
    this.name = "WebhookConfigurationError";
    this.code = code;
  }
}

export type WebhookVerificationErrorCode =
  | "MISSING_SIGNATURE"
  | "MALFORMED_SIGNATURE"
  | "UNSUPPORTED_ALGORITHM"
  | "INVALID_TYPE"
  | "UNKNOWN_KEY"
  | "INVALID_SIGNATURE"
  | "BODY_TOO_LARGE"
  | "INVALID_BODY"
  | "BODY_MISMATCH"
  | "INVALID_EVENT"
  | "STALE_EVENT"
  | "FUTURE_EVENT"
  | "ISSUER_MISMATCH"
  | "AUDIENCE_MISMATCH"
  | "KEY_SET_UNAVAILABLE"
  | "DUPLICATE_CHECK_FAILED";

export class WebhookVerificationError extends Error {
  readonly code: WebhookVerificationErrorCode;

  constructor(code: WebhookVerificationErrorCode) {
    const messages: Record<WebhookVerificationErrorCode, string> = {
      MISSING_SIGNATURE: "The Mayi signature header is required",
      MALFORMED_SIGNATURE: "The Mayi signature header is malformed",
      UNSUPPORTED_ALGORITHM: "The webhook signature algorithm is unsupported",
      INVALID_TYPE: "The webhook signature type is invalid",
      UNKNOWN_KEY: "The webhook signing key is unknown",
      INVALID_SIGNATURE: "The webhook signature is invalid",
      BODY_TOO_LARGE: "The webhook body exceeds the supported size",
      INVALID_BODY: "The webhook body is not valid JSON",
      BODY_MISMATCH: "The signed payload does not match the webhook body",
      INVALID_EVENT: "The webhook event is invalid",
      STALE_EVENT: "The webhook event is stale",
      FUTURE_EVENT: "The webhook event time is in the future",
      ISSUER_MISMATCH: "The webhook issuer is invalid",
      AUDIENCE_MISMATCH: "The webhook audience is invalid",
      KEY_SET_UNAVAILABLE: "The Mayi signing keys are unavailable",
      DUPLICATE_CHECK_FAILED: "The webhook duplicate check failed",
    };
    super(messages[code]);
    this.name = "WebhookVerificationError";
    this.code = code;
  }
}

interface CachedKeys {
  expiresAt: number;
  keys: Map<string, CryptoKey>;
}

function defaultFetch(): WebhookVerifierFetch {
  if (typeof globalThis.fetch !== "function") throw new WebhookConfigurationError("FETCH_UNAVAILABLE");
  return globalThis.fetch.bind(globalThis);
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function jwksUrl(options: WebhookVerifierOptions): URL {
  let origin: URL;
  try {
    origin = new URL(options.mayiOrigin);
  } catch {
    throw new WebhookConfigurationError("INVALID_ORIGIN");
  }
  if (
    origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
    || (origin.protocol !== "https:" && origin.protocol !== "http:")
  ) throw new WebhookConfigurationError("INVALID_ORIGIN");
  if (
    origin.protocol !== "https:"
    && !(options.dangerouslyAllowInsecureHttpForTests === true && isLocalHostname(origin.hostname))
  ) throw new WebhookConfigurationError("INSECURE_ORIGIN");
  return new URL(MAYI_JWKS_PATH, origin);
}

function positiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function bodyBytes(body: string | Uint8Array): Uint8Array {
  if (typeof body === "string") {
    if (body.length > MAX_WEBHOOK_BODY_BYTES) throw new WebhookVerificationError("BODY_TOO_LARGE");
    const bytes = new TextEncoder().encode(body);
    if (bytes.byteLength > MAX_WEBHOOK_BODY_BYTES) throw new WebhookVerificationError("BODY_TOO_LARGE");
    return bytes;
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > MAX_WEBHOOK_BODY_BYTES) throw new WebhookVerificationError("BODY_TOO_LARGE");
    return Uint8Array.from(body);
  }
  throw new WebhookVerificationError("INVALID_BODY");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_JWKS_BYTES)) {
    throw new WebhookVerificationError("KEY_SET_UNAVAILABLE");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JWKS_BYTES) {
        await reader.cancel();
        throw new WebhookVerificationError("KEY_SET_UNAVAILABLE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WebhookVerificationError) throw error;
    throw new WebhookVerificationError("KEY_SET_UNAVAILABLE");
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodeJwksJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new WebhookVerificationError("KEY_SET_UNAVAILABLE");
  }
}

function validPublicSigningJwk(value: unknown): value is JWK & { kid: string; x: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  if (
    key.kty !== "OKP"
    || key.crv !== "Ed25519"
    || typeof key.x !== "string"
    || typeof key.kid !== "string"
    || !KID_PATTERN.test(key.kid)
    || "d" in key
    || (key.use !== undefined && key.use !== "sig")
    || (key.alg !== undefined && key.alg !== "EdDSA")
  ) return false;
  if (key.key_ops !== undefined) {
    if (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== "verify") return false;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(key.x)) return false;
  try {
    const decoded = atob(key.x.replace(/-/g, "+").replace(/_/g, "/") + "=");
    const canonical = btoa(decoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return decoded.length === 32 && canonical === key.x;
  } catch {
    return false;
  }
}

async function importJwks(value: unknown): Promise<Map<string, CryptoKey>> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Array.isArray((value as { keys?: unknown }).keys)
  ) throw new WebhookVerificationError("KEY_SET_UNAVAILABLE");
  const values = (value as { keys: unknown[] }).keys;
  if (values.length === 0 || values.length > MAX_JWKS_KEYS) {
    throw new WebhookVerificationError("KEY_SET_UNAVAILABLE");
  }
  const result = new Map<string, CryptoKey>();
  try {
    for (const value of values) {
      if (!validPublicSigningJwk(value) || result.has(value.kid)) {
        throw new WebhookVerificationError("KEY_SET_UNAVAILABLE");
      }
      const key = await importJWK(value, "EdDSA");
      if (!(key instanceof CryptoKey) || key.type !== "public") {
        throw new WebhookVerificationError("KEY_SET_UNAVAILABLE");
      }
      result.set(value.kid, key);
    }
  } catch {
    throw new WebhookVerificationError("KEY_SET_UNAVAILABLE");
  }
  return result;
}

function parseRawBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new WebhookVerificationError("INVALID_BODY");
  }
}

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string") && value.includes(expected);
}

export function createWebhookVerifier(options: WebhookVerifierOptions): WebhookVerifier {
  if (!options || typeof options !== "object") throw new WebhookConfigurationError("INVALID_ORIGIN");
  const url = jwksUrl(options);
  if (!positiveInteger(options.maximumEventAgeSeconds, MAX_EVENT_AGE_SECONDS)) {
    throw new WebhookConfigurationError("INVALID_MAXIMUM_EVENT_AGE");
  }
  const cacheTtlSeconds = options.cacheTtlSeconds ?? 5 * 60;
  if (!positiveInteger(cacheTtlSeconds, MAX_CACHE_TTL_SECONDS)) throw new WebhookConfigurationError("INVALID_CACHE_TTL");
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  if (!positiveInteger(requestTimeoutMs, MAX_REQUEST_TIMEOUT_MS)) {
    throw new WebhookConfigurationError("INVALID_REQUEST_TIMEOUT");
  }
  const clockToleranceSeconds = options.clockToleranceSeconds ?? 30;
  if (
    !Number.isSafeInteger(clockToleranceSeconds)
    || clockToleranceSeconds < 0
    || clockToleranceSeconds > MAX_CLOCK_TOLERANCE_SECONDS
  ) throw new WebhookConfigurationError("INVALID_CLOCK_TOLERANCE");
  if (options.expectedIssuer !== undefined && (typeof options.expectedIssuer !== "string" || !options.expectedIssuer)) {
    throw new WebhookConfigurationError("INVALID_EXPECTED_ISSUER");
  }
  if (options.expectedAudience !== undefined && (typeof options.expectedAudience !== "string" || !options.expectedAudience)) {
    throw new WebhookConfigurationError("INVALID_EXPECTED_AUDIENCE");
  }
  const fetchImplementation = options.fetch ?? defaultFetch();
  if (typeof fetchImplementation !== "function") throw new WebhookConfigurationError("FETCH_UNAVAILABLE");
  const now = options.now ?? Date.now;
  let cache: CachedKeys | undefined;
  let refresh: Promise<CachedKeys> | undefined;
  let lastUnknownKeyRefreshAt: number | undefined;

  async function refreshKeys(): Promise<CachedKeys> {
    if (refresh) return refresh;
    refresh = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetchImplementation(url, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok || response.redirected) throw new WebhookVerificationError("KEY_SET_UNAVAILABLE");
        if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
          throw new WebhookVerificationError("KEY_SET_UNAVAILABLE");
        }
        const keys = await importJwks(decodeJwksJson(await readBoundedBody(response)));
        const loaded: CachedKeys = { expiresAt: now() + cacheTtlSeconds * 1_000, keys };
        if (!Number.isFinite(loaded.expiresAt)) throw new WebhookVerificationError("KEY_SET_UNAVAILABLE");
        cache = loaded;
        return loaded;
      } catch {
        throw new WebhookVerificationError("KEY_SET_UNAVAILABLE");
      } finally {
        clearTimeout(timeout);
        refresh = undefined;
      }
    })();
    return refresh;
  }

  async function keyFor(kid: string): Promise<CryptoKey> {
    const checkedAt = now();
    const usedFreshCache = Boolean(cache && cache.expiresAt > checkedAt);
    let current = usedFreshCache ? cache! : await refreshKeys();
    let key = current.keys.get(kid);
    if (!key && usedFreshCache) {
      if (
        lastUnknownKeyRefreshAt !== undefined
        && checkedAt - lastUnknownKeyRefreshAt < UNKNOWN_KEY_REFRESH_COOLDOWN_MS
      ) throw new WebhookVerificationError("UNKNOWN_KEY");
      // Account before awaiting so concurrent unknown kids cannot each start a refresh.
      lastUnknownKeyRefreshAt = checkedAt;
      current = await refreshKeys();
      key = current.keys.get(kid);
    } else if (!key) {
      // The cold/expired-cache fetch already served as this unknown kid's refresh.
      lastUnknownKeyRefreshAt = checkedAt;
    }
    if (!key) throw new WebhookVerificationError("UNKNOWN_KEY");
    return key;
  }

  return {
    async verify(input) {
      if (!input || typeof input !== "object") throw new WebhookVerificationError("INVALID_BODY");
      const bytes = bodyBytes(input.body);
      if (bytes.byteLength > MAX_WEBHOOK_BODY_BYTES) throw new WebhookVerificationError("BODY_TOO_LARGE");
      if (input.signature === null || input.signature === undefined || input.signature === "") {
        throw new WebhookVerificationError("MISSING_SIGNATURE");
      }
      if (
        typeof input.signature !== "string"
        || input.signature.length === 0
        || input.signature.length > MAX_SIGNATURE_BYTES
        || /\s/.test(input.signature)
        || input.signature.split(".").length !== 3
        || input.signature.split(".").some((part) => part.length === 0)
      ) throw new WebhookVerificationError("MALFORMED_SIGNATURE");

      let header: ReturnType<typeof decodeProtectedHeader>;
      try {
        header = decodeProtectedHeader(input.signature);
      } catch {
        throw new WebhookVerificationError("MALFORMED_SIGNATURE");
      }
      if (header.alg !== "EdDSA") throw new WebhookVerificationError("UNSUPPORTED_ALGORITHM");
      if (header.typ !== WEBHOOK_JWS_TYPE) throw new WebhookVerificationError("INVALID_TYPE");
      if (typeof header.kid !== "string" || !KID_PATTERN.test(header.kid) || "b64" in header || "crit" in header) {
        throw new WebhookVerificationError("MALFORMED_SIGNATURE");
      }

      const key = await keyFor(header.kid);
      let signedPayload: Uint8Array;
      try {
        signedPayload = (await compactVerify(input.signature, key, { algorithms: ["EdDSA"] })).payload;
      } catch {
        throw new WebhookVerificationError("INVALID_SIGNATURE");
      }
      const issuer = (header as Record<string, unknown>).iss;
      if (
        issuer !== undefined
        && (typeof issuer !== "string" || options.expectedIssuer === undefined || issuer !== options.expectedIssuer)
      ) throw new WebhookVerificationError("ISSUER_MISMATCH");
      const audience = (header as Record<string, unknown>).aud;
      if (
        audience !== undefined
        && (options.expectedAudience === undefined || !audienceMatches(audience, options.expectedAudience))
      ) throw new WebhookVerificationError("AUDIENCE_MISMATCH");

      const rawEvent = parseRawBody(bytes);
      let canonicalBody: Uint8Array;
      try {
        canonicalBody = new TextEncoder().encode(canonicalize(rawEvent));
      } catch {
        throw new WebhookVerificationError("INVALID_BODY");
      }
      if (!equalBytes(signedPayload, canonicalBody)) throw new WebhookVerificationError("BODY_MISMATCH");
      const parsed = ApprovalResolvedEventSchema.safeParse(rawEvent);
      if (!parsed.success) throw new WebhookVerificationError("INVALID_EVENT");

      const currentTime = now();
      if (!Number.isFinite(currentTime)) throw new WebhookVerificationError("INVALID_EVENT");
      const occurredAt = Date.parse(parsed.data.occurredAt);
      const toleranceMs = clockToleranceSeconds * 1_000;
      if (occurredAt > currentTime + toleranceMs) throw new WebhookVerificationError("FUTURE_EVENT");
      if (occurredAt < currentTime - options.maximumEventAgeSeconds * 1_000 - toleranceMs) {
        throw new WebhookVerificationError("STALE_EVENT");
      }

      if (options.isProcessed) {
        let duplicate: boolean;
        try {
          duplicate = await options.isProcessed(parsed.data.id);
        } catch {
          throw new WebhookVerificationError("DUPLICATE_CHECK_FAILED");
        }
        if (typeof duplicate !== "boolean") throw new WebhookVerificationError("DUPLICATE_CHECK_FAILED");
        if (duplicate) return { duplicate: true, eventId: parsed.data.id };
      }
      return { duplicate: false, event: parsed.data };
    },
  };
}
