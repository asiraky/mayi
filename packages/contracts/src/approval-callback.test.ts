import { describe, expect, it } from "vitest";
import {
  Action,
  actionAudience,
  actionName,
  ApprovalRequest,
  ApprovalResolvedEvent,
  createId,
  SealedCallbackStateEnvelope,
} from "./index";

describe("approval request contracts", () => {
  const action = {
    kind: "tool-call" as const,
    toolName: "deploy",
    callId: "EveCallId",
    input: { version: "1.2.3" },
  };

  it("accepts the one-call approval request shape", () => {
    expect(ApprovalRequest.parse({
      action,
      explanation: "Deploy version 1.2.3 to production.",
      suggestedApproverId: createId(),
      expiresInSeconds: 3_600,
      callback: { url: "https://agent.example/eve/v1/mayi/approval-resolved", state: "opaque-state" },
    })).toMatchObject({ action, expiresInSeconds: 3_600 });
  });

  it("rejects the superseded action parameters shape", () => {
    expect(Action.safeParse({
      kind: "deploy.release",
      version: "1",
      audience: "production-deployer",
      parameters: { version: "1.2.3" },
    }).success).toBe(false);
  });

  it("names and scopes both action variants consistently", () => {
    expect(actionName(action)).toBe("deploy");
    expect(actionAudience(action)).toBeUndefined();

    const versioned = Action.parse({
      kind: "deploy.release",
      version: "1",
      audience: "production-deployer",
      input: { version: "1.2.3" },
    });
    expect(actionName(versioned)).toBe("deploy.release");
    expect(actionAudience(versioned)).toBe("production-deployer");
  });
});

describe("approval resolution event contract", () => {
  const base = {
    id: createId(),
    type: "approval.resolved" as const,
    version: 1 as const,
    approvalId: createId(),
    state: "opaque-state",
    occurredAt: "2026-07-15T00:00:00.000Z",
  };

  it("accepts an approved event with its approver and receipt", () => {
    expect(ApprovalResolvedEvent.parse({
      ...base,
      status: "approved",
      approver: { id: createId() },
      receipt: "compact-jws",
    }).status).toBe("approved");
  });

  it("requires a human approver for denial", () => {
    expect(ApprovalResolvedEvent.safeParse({ ...base, status: "denied" }).success).toBe(false);
  });

  it("does not allow receipts on non-approved events", () => {
    expect(ApprovalResolvedEvent.safeParse({ ...base, status: "expired", receipt: "unexpected" }).success).toBe(false);
  });
});

describe("sealed callback state envelope contract", () => {
  it("accepts the versioned AEAD transport fields without implementing a codec", () => {
    expect(SealedCallbackStateEnvelope.parse({
      version: 1,
      kid: "host-key.2026-07",
      nonce: "bm9uY2U",
      ciphertext: "Y2lwaGVydGV4dC10YWc",
    })).toEqual({
      version: 1,
      kid: "host-key.2026-07",
      nonce: "bm9uY2U",
      ciphertext: "Y2lwaGVydGV4dC10YWc",
    });
  });

  it("rejects unsupported envelope versions", () => {
    expect(SealedCallbackStateEnvelope.safeParse({
      version: 2,
      kid: "host-key",
      nonce: "bm9uY2U",
      ciphertext: "Y2lwaGVydGV4dA",
    }).success).toBe(false);
  });
});
