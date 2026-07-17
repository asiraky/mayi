import { describe, expect, it } from "vitest";
import { MayiEveConfigurationError, resolvePublicOrigin } from "./origin";

function errorCode(code: string) {
  return expect.objectContaining({ code });
}

describe("resolvePublicOrigin", () => {
  it("prefers EVE_PUBLIC_ORIGIN over Vercel production and development overrides", () => {
    expect(resolvePublicOrigin({
      environment: {
        EVE_PUBLIC_ORIGIN: "https://agent.example",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "project.vercel.app",
      },
      developmentOverride: "https://tunnel.example",
    })).toBe("https://agent.example");
  });

  it("uses only the stable Vercel production URL in a production deployment", () => {
    expect(resolvePublicOrigin({
      environment: {
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "stable-project.vercel.app",
        VERCEL_URL: "project-git-feature-team.vercel.app",
      },
    })).toBe("https://stable-project.vercel.app");
  });

  it("allows an explicit public HTTPS development or tunnel override", () => {
    expect(resolvePublicOrigin({
      environment: { NODE_ENV: "development" },
      developmentOverride: "https://mayi-tunnel.example",
    })).toBe("https://mayi-tunnel.example");
  });

  it("never falls back to transient preview URLs", () => {
    expect(() => resolvePublicOrigin({
      environment: {
        VERCEL_ENV: "preview",
        VERCEL_URL: "project-git-feature-team.vercel.app",
        VERCEL_BRANCH_URL: "project-git-feature-team.vercel.app",
      },
    })).toThrow(errorCode("PUBLIC_ORIGIN_UNAVAILABLE"));

    expect(() => resolvePublicOrigin({
      environment: {
        EVE_PUBLIC_ORIGIN: "https://project-git-feature-team.vercel.app",
        VERCEL_ENV: "preview",
        VERCEL_URL: "project-git-feature-team.vercel.app",
      },
    })).toThrow(errorCode("PREVIEW_ORIGIN_REFUSED"));
  });

  it("accepts a path-bearing public base URL for path-routed hosts", () => {
    expect(resolvePublicOrigin({
      environment: { EVE_PUBLIC_ORIGIN: "https://eden.example/e/abc123def456" },
    })).toBe("https://eden.example/e/abc123def456");
  });

  it.each([
    ["https://eden.example/e/abc123def456/", "https://eden.example/e/abc123def456"],
    ["https://eden.example/e/abc123def456///", "https://eden.example/e/abc123def456"],
    ["https://agent.example/", "https://agent.example"],
    ["https://agent.example///", "https://agent.example"],
    ["https://agent.example", "https://agent.example"],
    // WHATWG parsing drops the default HTTPS port before validation, exactly
    // as it always has for root origins.
    ["https://agent.example:443/e/abc123def456", "https://agent.example/e/abc123def456"],
  ])("normalizes %s", (input, expected) => {
    expect(resolvePublicOrigin({ environment: { EVE_PUBLIC_ORIGIN: input } })).toBe(expected);
  });

  it("bounds the base so the joined callback URL stays registrable", () => {
    const prefix = "https://eden.example/e/";
    const fits = `${prefix}${"a".repeat(2_018 - prefix.length)}`;
    expect(resolvePublicOrigin({ environment: { EVE_PUBLIC_ORIGIN: fits } })).toBe(fits);
    expect(() => resolvePublicOrigin({ environment: { EVE_PUBLIC_ORIGIN: `${fits}a` } }))
      .toThrow(errorCode("INVALID_PUBLIC_ORIGIN"));
  });

  it("refuses trailing-dot hostnames that would evade transient-preview matching", () => {
    expect(() => resolvePublicOrigin({
      environment: {
        EVE_PUBLIC_ORIGIN: "https://project-git-feature-team.vercel.app./e/abc123def456",
        VERCEL_ENV: "preview",
        VERCEL_URL: "project-git-feature-team.vercel.app",
      },
    })).toThrow(errorCode("INVALID_PUBLIC_ORIGIN"));
    expect(() => resolvePublicOrigin({ environment: { EVE_PUBLIC_ORIGIN: "https://agent.example." } }))
      .toThrow(errorCode("INVALID_PUBLIC_ORIGIN"));
  });

  it("keeps the Vercel production fallback origin-only", () => {
    expect(() => resolvePublicOrigin({
      environment: {
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "stable-project.vercel.app/e/wrong",
      },
    })).toThrow(errorCode("INVALID_PUBLIC_ORIGIN"));
  });

  it("refuses transient preview hostnames even with a path prefix", () => {
    expect(() => resolvePublicOrigin({
      environment: {
        EVE_PUBLIC_ORIGIN: "https://project-git-feature-team.vercel.app/e/abc123def456",
        VERCEL_ENV: "preview",
        VERCEL_URL: "project-git-feature-team.vercel.app",
      },
    })).toThrow(errorCode("PREVIEW_ORIGIN_REFUSED"));
  });

  it.each([
    "http://agent.example",
    "https://localhost",
    "https://127.0.0.1",
    "https://agent.internal",
    "https://user:password@agent.example",
    "https://agent.example:8443",
    "https://agent.example?secret=bypass-token",
    "https://agent.example/callback#fragment",
    "https://agent.example/callback?secret=bypass-token",
    "https://user:password@agent.example/callback",
    "https://agent.example:8443/callback",
    "https://localhost/callback",
  ])("fails closed for non-public base %s", (base) => {
    expect(() => resolvePublicOrigin({ environment: { EVE_PUBLIC_ORIGIN: base } }))
      .toThrow(errorCode("INVALID_PUBLIC_ORIGIN"));
  });

  it("fails closed when no stable origin is available", () => {
    expect(() => resolvePublicOrigin({ environment: {} })).toThrow(MayiEveConfigurationError);
    expect(() => resolvePublicOrigin({ environment: {} })).toThrow(errorCode("PUBLIC_ORIGIN_UNAVAILABLE"));
  });
});
