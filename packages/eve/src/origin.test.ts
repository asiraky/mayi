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

  it.each([
    "http://agent.example",
    "https://localhost",
    "https://127.0.0.1",
    "https://agent.internal",
    "https://user:password@agent.example",
    "https://agent.example:8443",
    "https://agent.example/callback",
    "https://agent.example?secret=bypass-token",
  ])("fails closed for non-public origin %s", (origin) => {
    expect(() => resolvePublicOrigin({ environment: { EVE_PUBLIC_ORIGIN: origin } }))
      .toThrow(errorCode("INVALID_PUBLIC_ORIGIN"));
  });

  it("fails closed when no stable origin is available", () => {
    expect(() => resolvePublicOrigin({ environment: {} })).toThrow(MayiEveConfigurationError);
    expect(() => resolvePublicOrigin({ environment: {} })).toThrow(errorCode("PUBLIC_ORIGIN_UNAVAILABLE"));
  });
});
