import { describe, expect, it, vi } from "vitest";
import {
  isPublicIpAddress,
  PublicUrlValidationError,
  validatePublicHttpsUrl,
  type PublicUrlResolver,
} from "./public-url";

const publicDns: PublicUrlResolver = async () => [
  { address: "203.1.1.10", family: 4 },
  { address: "2606:4700:4700::1111", family: 6 },
];

describe("validatePublicHttpsUrl", () => {
  it("accepts a public HTTPS URL and returns pinning and redirect metadata", async () => {
    const resolve = vi.fn(publicDns);
    const result = await validatePublicHttpsUrl("https://agent.example/approval-resolved?tenant=one", { resolve });

    expect(resolve).toHaveBeenCalledWith("agent.example");
    expect(result.url.href).toBe("https://agent.example/approval-resolved?tenant=one");
    expect(result.addresses).toEqual(["203.1.1.10", "2606:4700:4700::1111"]);
    expect(result.pinnedAddress).toBe("203.1.1.10");
    expect(result.redirect).toBe("error");
  });

  it.each([
    ["http://agent.example/callback", "https_required"],
    ["ftp://agent.example/callback", "https_required"],
    ["https://user@agent.example/callback", "credentials_forbidden"],
    ["https://user:secret@agent.example/callback", "credentials_forbidden"],
    ["https://agent.example:8443/callback", "default_port_required"],
  ])("rejects invalid callback authority %s", async (value, code) => {
    await expect(validatePublicHttpsUrl(value, { resolve: publicDns })).rejects.toMatchObject({
      name: "PublicUrlValidationError",
      code,
    });
  });

  it("accepts an explicitly stated default HTTPS port", async () => {
    const result = await validatePublicHttpsUrl("https://agent.example:443/callback", { resolve: publicDns });
    expect(result.url.href).toBe("https://agent.example/callback");
  });

  it.each([
    "https://localhost/callback",
    "https://localhost./callback",
    "https://service.localhost/callback",
    "https://service.local/callback",
    "https://service.internal/callback",
    "https://router.lan/callback",
    "https://device.home/callback",
    "https://service.home.arpa/callback",
  ])("rejects internal hostname %s without resolving it", async (value) => {
    const resolve = vi.fn(publicDns);
    await expect(validatePublicHttpsUrl(value, { resolve })).rejects.toMatchObject({ code: "internal_hostname" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
  ])("rejects non-public IPv4 address %s", async (address) => {
    await expect(validatePublicHttpsUrl(`https://${address}/callback`)).rejects.toMatchObject({ code: "non_public_address" });
  });

  it.each([
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "3fff::1",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
  ])("rejects non-public IPv6 address %s", async (address) => {
    await expect(validatePublicHttpsUrl(`https://[${address}]/callback`)).rejects.toMatchObject({ code: "non_public_address" });
  });

  it("rejects DNS answers if any address is non-public", async () => {
    const resolve: PublicUrlResolver = async () => ["203.1.1.10", "127.0.0.1"];
    await expect(validatePublicHttpsUrl("https://agent.example/callback", { resolve })).rejects.toMatchObject({
      code: "non_public_address",
    });
  });

  it("fails closed when DNS fails or returns no addresses", async () => {
    const failed: PublicUrlResolver = async () => { throw new Error("resolver unavailable"); };
    const empty: PublicUrlResolver = async () => [];

    await expect(validatePublicHttpsUrl("https://agent.example/callback", { resolve: failed })).rejects.toMatchObject({
      code: "dns_resolution_failed",
    });
    await expect(validatePublicHttpsUrl("https://agent.example/callback", { resolve: empty })).rejects.toMatchObject({
      code: "dns_resolution_failed",
    });
  });

  it("rejects malformed resolver output", async () => {
    const resolve: PublicUrlResolver = async () => ["not-an-address"];
    await expect(validatePublicHttpsUrl("https://agent.example/callback", { resolve })).rejects.toMatchObject({
      code: "non_public_address",
    });
  });

  it("does not call DNS for a public address literal", async () => {
    const resolve = vi.fn(publicDns);
    const ipv4 = await validatePublicHttpsUrl("https://8.8.8.8/callback", { resolve });
    const ipv6 = await validatePublicHttpsUrl("https://[2606:4700:4700::1111]/callback", { resolve });

    expect(resolve).not.toHaveBeenCalled();
    expect(ipv4.pinnedAddress).toBe("8.8.8.8");
    expect(ipv6.pinnedAddress).toBe("2606:4700:4700::1111");
  });
});

describe("isPublicIpAddress", () => {
  it.each([
    ["8.8.8.8", true],
    ["192.0.2.1", false],
    ["2606:4700:4700::1111", true],
    ["::ffff:8.8.8.8", false],
    ["not-an-address", false],
  ])("classifies %s", (address, expected) => {
    expect(isPublicIpAddress(address)).toBe(expected);
  });

  it("exposes a specific validation error type", () => {
    const error = new PublicUrlValidationError("invalid_url", "invalid");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("invalid_url");
  });
});
