import { describe, expect, it, vi } from "vitest";
import type { AgentAuth } from "./auth";
import { authorizeApprovalCallback } from "./approval-callback";
import type { PublicUrlResolver } from "./public-url";

const callback = "https://agent.example/eve/v1/mayi/approval-resolved";
const resolve: PublicUrlResolver = async () => ["203.1.1.10"];
const auth = (clientId: string | null): AgentAuth => ({
  kind: "agent",
  agentId: "agent_1",
  workspaceId: "workspace_1",
  clientId,
  scopes: ["approval:write"],
});

describe("authorizeApprovalCallback", () => {
  it("accepts an exact URL registered to the authenticated OAuth client", async () => {
    const loadUris = vi.fn(async (clientId: string) => clientId === "client_a" ? [callback] : []);
    const result = await authorizeApprovalCallback(auth("client_a"), callback, { loadUris, resolve });

    expect(loadUris).toHaveBeenCalledWith("client_a");
    expect(result.pinnedAddress).toBe("203.1.1.10");
  });

  it("rejects a URL registered to client A for a token bound to client B", async () => {
    const registrations = new Map([["client_a", [callback]], ["client_b", []]]);
    const loadUris = async (clientId: string) => registrations.get(clientId) ?? [];

    await expect(authorizeApprovalCallback(auth("client_b"), callback, { loadUris, resolve }))
      .rejects.toThrow(/not registered for this OAuth client/);
  });

  it("rejects agents that have no OAuth client binding", async () => {
    const loadUris = vi.fn(async () => [callback]);
    await expect(authorizeApprovalCallback(auth(null), callback, { loadUris, resolve }))
      .rejects.toThrow(/client-bound agent authentication/);
    expect(loadUris).not.toHaveBeenCalled();
  });

  it.each([
    ["different path", "https://agent.example/eve/v1/mayi/other"],
    ["non-default port", "https://agent.example:8443/eve/v1/mayi/approval-resolved"],
    ["different scheme", "http://agent.example/eve/v1/mayi/approval-resolved"],
    ["trailing slash", `${callback}/`],
    ["case change", "https://AGENT.example/eve/v1/mayi/approval-resolved"],
    ["userinfo", "https://user@agent.example/eve/v1/mayi/approval-resolved"],
  ])("rejects an exact-match near miss: %s", async (_label, value) => {
    const dns = vi.fn(resolve);
    await expect(authorizeApprovalCallback(auth("client_a"), value, {
      loadUris: async () => [callback],
      resolve: dns,
    })).rejects.toThrow(/not registered/);
    expect(dns).not.toHaveBeenCalled();
  });
});
