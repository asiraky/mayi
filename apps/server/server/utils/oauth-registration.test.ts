import type { H3Event } from "h3";
import { describe, expect, it, vi } from "vitest";
import {
  assertRegistrationAttemptAllowed,
  assertRegistrationRateAllowed,
  OAUTH_REGISTRATION_LIMITS,
  parseAndValidateRegistration,
  normalizeRegistrationClientAddress,
  registrationClientAddress,
  RegistrationValidationGate,
  validateRedirectUri,
} from "../api/oauth/register.post";
import type { PublicUrlResolver } from "./public-url";

const publicDns: PublicUrlResolver = async () => ["203.1.1.10"];

function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_name: "Eden agent",
    redirect_uris: ["https://eden.example/oauth/mayi/callback"],
    approval_callback_uris: ["https://agent.example/eve/v1/mayi/approval-resolved"],
    ...overrides,
  };
}

async function parse(input: Record<string, unknown>, resolve: PublicUrlResolver = publicDns) {
  return parseAndValidateRegistration(JSON.stringify(input), { production: true, resolve });
}

describe("OAuth dynamic client registration validation", () => {
  it("preserves exact redirect and approval callback URI strings", async () => {
    const input = registration({
      approval_callback_uris: ["https://agent.example:443/eve/v1/mayi/approval-resolved"],
    });
    const output = await parse(input);

    expect(output).toEqual(input);
  });

  it("resolves every approval callback during registration", async () => {
    const resolve = vi.fn(publicDns);
    await parse(registration({
      approval_callback_uris: [
        "https://one.example/callback",
        "https://two.example/callback",
      ],
    }), resolve);
    expect(resolve.mock.calls).toEqual([["one.example"], ["two.example"]]);
  });

  it("rejects a callback whose DNS includes a non-public address", async () => {
    await expect(parse(registration(), async () => ["203.1.1.10", "10.0.0.1"]))
      .rejects.toThrow(/exclusively to public addresses/);
  });

  it.each([
    ["duplicate redirect", { redirect_uris: ["https://eden.example/callback", "https://eden.example/callback"] }],
    ["duplicate callback", { approval_callback_uris: ["https://agent.example/callback", "https://agent.example/callback"] }],
    ["empty callbacks", { approval_callback_uris: [] }],
    ["too many redirects", { redirect_uris: Array.from({ length: 6 }, (_, index) => `https://eden${index}.example/callback`) }],
    ["too many callbacks", { approval_callback_uris: Array.from({ length: 11 }, (_, index) => `https://agent${index}.example/callback`) }],
    ["long name", { client_name: "a".repeat(101) }],
    ["long redirect URI", { redirect_uris: [`https://eden.example/${"a".repeat(2049)}`] }],
    ["long callback URI", { approval_callback_uris: [`https://agent.example/${"a".repeat(2049)}`] }],
  ])("enforces the registration limit: %s", async (_label, override) => {
    await expect(parse(registration(override))).rejects.toThrow(/Invalid OAuth client registration/);
  });

  it("enforces the raw UTF-8 body byte limit before JSON parsing", async () => {
    const raw = "é".repeat(OAUTH_REGISTRATION_LIMITS.bodyBytes / 2 + 1);
    await expect(parseAndValidateRegistration(raw, { production: true, resolve: publicDns }))
      .rejects.toThrow(/exceeds 32 KiB/);
  });

  it("rejects malformed JSON", async () => {
    await expect(parseAndValidateRegistration("{", { production: true, resolve: publicDns }))
      .rejects.toThrow(/valid JSON/);
  });

  it.each([
    "http://eden.example/callback",
    "https://eden.example:8443/callback",
    "https://user@eden.example/callback",
    "https://eden.example/callback#fragment",
  ])("rejects an unsafe production redirect URI: %s", (value) => {
    expect(() => validateRedirectUri(value, true)).toThrow(/Redirect URI/);
  });

  it("allows only loopback HTTP as the development redirect exception", () => {
    expect(() => validateRedirectUri("http://localhost:3000/callback", false)).not.toThrow();
    expect(() => validateRedirectUri("http://127.0.0.1:4321/callback", false)).not.toThrow();
    expect(() => validateRedirectUri("http://example.com:3000/callback", false)).toThrow(/HTTPS/);
  });

  it("enforces ten successful registrations per source IP per rolling hour", () => {
    expect(() => assertRegistrationRateAllowed(9)).not.toThrow();
    expect(() => assertRegistrationRateAllowed(10)).toThrow(/rate limit/);
  });

  it("rejects attempts beyond the shared hourly budget", () => {
    expect(() => assertRegistrationAttemptAllowed(OAUTH_REGISTRATION_LIMITS.attemptsPerIpPerHour)).not.toThrow();
    expect(() => assertRegistrationAttemptAllowed(OAUTH_REGISTRATION_LIMITS.attemptsPerIpPerHour + 1))
      .toThrow(/attempt limit/);
  });

  it.each([
    "198.51.100.20, 10.0.0.2",
    "198.51.100.20 10.0.0.2",
    "attacker-controlled",
    "999.999.999.999",
    "::::",
    "",
  ])("rejects ambiguous or non-address trusted proxy identity: %j", (value) => {
    expect(() => normalizeRegistrationClientAddress(value)).toThrow(/source IP/);
  });

  it.each(["203.0.113.9", "2001:db8::9", "::ffff:127.0.0.1"])(
    "accepts a single direct or trusted address: %s",
    (value) => expect(normalizeRegistrationClientAddress(value)).toBe(value),
  );

  it("ignores a caller-supplied forwarded header unless a trusted source is configured", () => {
    const event = {
      context: {},
      node: {
        req: {
          headers: { "x-forwarded-for": "203.0.113.99" },
          socket: { remoteAddress: "198.51.100.7" },
        },
      },
    } as unknown as H3Event;
    expect(registrationClientAddress(event, {})).toBe("198.51.100.7");
  });

  it("uses Nitro's single-address forwarded identity only when the development proxy hides the socket", () => {
    const event = {
      context: {},
      node: {
        req: {
          headers: { "x-forwarded-for": "::ffff:127.0.0.1" },
          socket: {},
        },
      },
    } as unknown as H3Event;
    expect(registrationClientAddress(event, {}, true)).toBe("::ffff:127.0.0.1");
    expect(() => registrationClientAddress(event, {}, false)).toThrow(/source IP/);
  });

  it("rejects a forwarded chain even through the development proxy fallback", () => {
    const event = {
      context: {},
      node: {
        req: {
          headers: { "x-forwarded-for": "203.0.113.99, 127.0.0.1" },
          socket: {},
        },
      },
    } as unknown as H3Event;
    expect(() => registrationClientAddress(event, {}, true)).toThrow(/source IP/);
  });

  it("uses only a configured single-address trusted header", () => {
    const event = {
      context: {},
      node: {
        req: {
          headers: {
            "x-mayi-client-ip": "203.0.113.8",
            "x-forwarded-for": "192.0.2.1, 10.0.0.1",
          },
          socket: { remoteAddress: "10.0.0.2" },
        },
      },
    } as unknown as H3Event;
    expect(registrationClientAddress(event, {
      OAUTH_REGISTRATION_TRUSTED_IP_HEADER: "x-mayi-client-ip",
    })).toBe("203.0.113.8");
  });

  it("falls back to the socket peer for direct access when the configured proxy header is absent", () => {
    const event = {
      context: {},
      node: {
        req: {
          headers: {},
          socket: { remoteAddress: "127.0.0.1" },
        },
      },
    } as unknown as H3Event;
    expect(registrationClientAddress(event, {
      OAUTH_REGISTRATION_TRUSTED_IP_HEADER: "x-forwarded-for",
    })).toBe("127.0.0.1");
  });

  it("selects Vercel's overwritten client header only in the Vercel runtime", () => {
    const event = {
      context: {},
      node: {
        req: {
          headers: { "x-vercel-forwarded-for": "203.0.113.10" },
          socket: { remoteAddress: "10.0.0.2" },
        },
      },
    } as unknown as H3Event;
    expect(registrationClientAddress(event, { VERCEL: "1" })).toBe("203.0.113.10");
  });

  it("bounds concurrent callback DNS validation work", async () => {
    const gate = new RegistrationValidationGate(2);
    let active = 0;
    let maximumActive = 0;
    const tasks = Array.from({ length: 5 }, () => gate.run(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
    }));
    await Promise.all(tasks);
    expect(maximumActive).toBe(2);
  });
});
