export const MAYI_CALLBACK_PATH = "/eve/v1/mayi/approval-resolved";

export interface MayiEnvironment {
  readonly EVE_PUBLIC_ORIGIN?: string;
  readonly MAYI_CALLBACK_STATE_KEY?: string;
  readonly MAYI_CALLBACK_STATE_KEY_ID?: string;
  readonly MAYI_CALLBACK_STATE_PREVIOUS_KEYS?: string;
  readonly MAYI_ORIGIN?: string;
  readonly NODE_ENV?: string;
  readonly VERCEL_BRANCH_URL?: string;
  readonly VERCEL_ENV?: string;
  readonly VERCEL_PROJECT_PRODUCTION_URL?: string;
  readonly VERCEL_URL?: string;
}

export type MayiEveConfigurationErrorCode =
  | "CALLBACK_STATE_KEY_UNAVAILABLE"
  | "INVALID_CALLBACK_STATE_KEYS"
  | "INVALID_CONFIG"
  | "INVALID_PUBLIC_ORIGIN"
  | "INVALID_RECEIVE_TARGET"
  | "PREVIEW_ORIGIN_REFUSED"
  | "PUBLIC_ORIGIN_UNAVAILABLE";

export class MayiEveConfigurationError extends Error {
  readonly code: MayiEveConfigurationErrorCode;

  constructor(code: MayiEveConfigurationErrorCode, message: string) {
    super(message);
    this.name = "MayiEveConfigurationError";
    this.code = code;
  }
}

export interface ResolvePublicOriginOptions {
  readonly environment?: MayiEnvironment;
  /** Explicit local-development or tunnel origin. Ignored in production. */
  readonly developmentOverride?: string;
}

function runtimeEnvironment(): MayiEnvironment {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: MayiEnvironment };
  };
  return runtime.process?.env ?? {};
}

function hostnameFromEnvironmentUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const candidate = value.includes("://") ? value : `https://${value}`;
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isNonPublicHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost"
    || lower.endsWith(".localhost")
    || lower.endsWith(".local")
    || lower.endsWith(".internal")
    || !lower.includes(".")
  ) return true;

  // Durable callback origins should be DNS names. Refusing every IP literal
  // also avoids accidentally accepting private, loopback, or link-local space.
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(lower) || lower.includes(":");
}

function normalizePublicHttpsBase(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.port
      || isNonPublicHostname(url.hostname)
    ) throw new Error("invalid base");
    // Path-routed hosts (a shared hostname whose ingress routes a prefix to
    // this instance) inject a path-bearing base; normalize away trailing
    // slashes so joining MAYI_CALLBACK_PATH always yields a single slash.
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    throw new MayiEveConfigurationError(
      "INVALID_PUBLIC_ORIGIN",
      "The Eve public base URL must be public HTTPS without credentials, query, fragment, or non-default port",
    );
  }
}

function assertNotTransientPreview(base: string, environment: MayiEnvironment): void {
  const hostname = new URL(base).hostname.toLowerCase();
  const productionHostname = hostnameFromEnvironmentUrl(environment.VERCEL_PROJECT_PRODUCTION_URL);
  const transientHostnames = [environment.VERCEL_URL, environment.VERCEL_BRANCH_URL]
    .map(hostnameFromEnvironmentUrl)
    .filter((item): item is string => item !== undefined && item !== productionHostname);
  if (transientHostnames.includes(hostname)) {
    throw new MayiEveConfigurationError(
      "PREVIEW_ORIGIN_REFUSED",
      "Transient Vercel preview URLs cannot be used for durable Mayi approval callbacks",
    );
  }
}

/**
 * Resolves the stable public HTTPS base URL Eve exposes for durable callbacks:
 * an origin plus an optional path prefix (no trailing slash), so path-routed
 * hosts such as `https://eden.example/e/abc123def456` are supported.
 */
export function resolvePublicOrigin(options: ResolvePublicOriginOptions = {}): string {
  const environment = options.environment ?? runtimeEnvironment();
  if (environment.EVE_PUBLIC_ORIGIN !== undefined) {
    const base = normalizePublicHttpsBase(environment.EVE_PUBLIC_ORIGIN);
    assertNotTransientPreview(base, environment);
    return base;
  }

  if (environment.VERCEL_ENV === "production" && environment.VERCEL_PROJECT_PRODUCTION_URL) {
    const value = environment.VERCEL_PROJECT_PRODUCTION_URL;
    const base = normalizePublicHttpsBase(value.includes("://") ? value : `https://${value}`);
    assertNotTransientPreview(base, environment);
    return base;
  }

  const production = environment.NODE_ENV === "production" || environment.VERCEL_ENV === "production";
  if (!production && options.developmentOverride !== undefined) {
    const base = normalizePublicHttpsBase(options.developmentOverride);
    assertNotTransientPreview(base, environment);
    return base;
  }

  throw new MayiEveConfigurationError(
    "PUBLIC_ORIGIN_UNAVAILABLE",
    "A stable public Eve origin is required; provision EVE_PUBLIC_ORIGIN for this deployment",
  );
}

export function getRuntimeEnvironment(): MayiEnvironment {
  return runtimeEnvironment();
}
