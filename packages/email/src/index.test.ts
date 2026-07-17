import { describe, expect, it } from "vitest";
import {
  renderApprovalRequestedEmail,
  renderInputRequestedEmail,
  renderPasswordResetEmail,
} from "./index";

describe("input requested email", () => {
  it("leads with the prompt and a single answering link", async () => {
    const html = await renderInputRequestedEmail({
      prompt: "Which environment should I deploy 1.2.3 to?",
      agentName: "Eve",
      workspaceName: "Acme",
      expiresInText: "in 1 hour",
      reviewUrl: "https://mayi.test/?input=abc123",
    });
    expect(html).toContain("An agent needs your input");
    expect(html).toContain("Which environment should I deploy 1.2.3 to?");
    expect(html).toContain("Answer this request");
    expect(html).toContain("https://mayi.test/?input=abc123");
    expect(html).toContain("Eve");
    expect(html).toContain("Acme");
  });
});

describe("approval requested email", () => {
  it("leads with the explanation and keeps identifiers and machine data out of the body", async () => {
    const html = await renderApprovalRequestedEmail({
      actionKind: "deploy_release",
      explanation: "Deploy version 1.2.3 to production so the fix ships before the demo.",
      agentName: "Eve",
      workspaceName: "Acme",
      highRisk: true,
      expiresAtIso: "2026-07-17T00:00:00.000Z",
      expiresInText: "in 1 hour",
      reviewUrl: "https://mayi.test/?approval=xyz789",
      approvalId: "0123456789abcdefghjkmnpqrs",
    });
    expect(html).toContain("Deploy version 1.2.3 to production so the fix ships before the demo.");
    expect(html).toContain("Review this request");
    expect(html).toContain("high-risk");
    expect(html).toContain("https://mayi.test/?approval=xyz789");
    // The body carries no request identifier, raw timestamp or digest — those live
    // behind the authenticated link.
    expect(html).not.toContain("0123456789abcdefghjkmnpqrs");
    expect(html).not.toContain("2026-07-17T00:00:00.000Z");
  });
});

describe("password reset email", () => {
  it("carries the reset link, expiry note and no-action reassurance", async () => {
    const html = await renderPasswordResetEmail({
      resetUrl: "https://mayi.test/reset?token=tok123",
    });
    expect(html).toContain("Password reset");
    expect(html).toContain("Reset password");
    expect(html).toContain("https://mayi.test/reset?token=tok123");
    expect(html).toContain("expires in 30 minutes");
    expect(html).toContain("your password is unchanged");
  });
});
