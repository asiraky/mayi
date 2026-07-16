import { describe, expect, it } from "vitest";
import { createId } from "@mayi/contracts";
import { decisionTransition, freezeDigests, isHighRisk, validateActionForEnforcement, validateInputAnswer, validateSuggestedApprover } from "./index";

describe("approval state", () => {
  it("uses authoritative time to expire instead of approving", () => {
    expect(decisionTransition("PENDING", new Date(100), new Date(101), "APPROVED")).toBe("EXPIRED");
  });

  it("allows exactly one transition away from pending", () => {
    expect(() => decisionTransition("DENIED", new Date(200), new Date(100), "APPROVED")).toThrow(/denied/);
  });

  it("rejects a requester-selected ineligible approver", () => {
    expect(() => validateSuggestedApprover("bad", ["good"])).toThrow(/outside server policy/);
  });
});

describe("executor-owned action schemas", () => {
  it("does not describe an unknown action as verified", () => {
    expect(() => validateActionForEnforcement({ kind: "custom.note", version: "1", audience: "test", input: {} }, "verified")).toThrow(/registered exact-action/);
  });
  it("allows unknown actions only as cooperative records", () => {
    expect(() => validateActionForEnforcement({ kind: "custom.note", version: "1", audience: "test", input: {} }, "cooperative")).not.toThrow();
  });
  it("allows tool calls only with cooperative enforcement", () => {
    const action = { kind: "tool-call" as const, toolName: "deploy.release", callId: "call-1", input: { release: "1.2.3" } };
    expect(() => validateActionForEnforcement(action, "cooperative")).not.toThrow();
    expect(() => validateActionForEnforcement(action, "verified")).toThrow(/cooperative enforcement/);
  });
  it("uses the tool name when classifying risk", () => {
    expect(isHighRisk({ kind: "tool-call", toolName: "admin.user.delete", callId: "call-1", input: {} })).toBe(true);
  });
});

describe("input answers", () => {
  const options = [
    { id: "proceed", label: "Proceed" },
    { id: "abort", label: "Abort" },
  ];

  it("requires text and forbids optionId on text inputs", () => {
    expect(() => validateInputAnswer({ type: "text", options: null, allowFreeform: false }, { text: "Ship it" })).not.toThrow();
    expect(() => validateInputAnswer({ type: "text", options: null, allowFreeform: false }, { optionId: "proceed" })).toThrow(/no optionId/);
    expect(() => validateInputAnswer({ type: "text", options: null, allowFreeform: false }, {})).toThrow(/optionId or text/);
  });

  it("requires an offered optionId on selects", () => {
    expect(() => validateInputAnswer({ type: "select", options, allowFreeform: false }, { optionId: "proceed" })).not.toThrow();
    expect(() => validateInputAnswer({ type: "select", options, allowFreeform: false }, { optionId: "other" })).toThrow(/not one of the offered options/);
  });

  it("allows freeform text on selects only when enabled", () => {
    expect(() => validateInputAnswer({ type: "select", options, allowFreeform: true }, { text: "Something else" })).not.toThrow();
    expect(() => validateInputAnswer({ type: "select", options, allowFreeform: true }, { optionId: "proceed", text: "With a note" })).not.toThrow();
    expect(() => validateInputAnswer({ type: "select", options, allowFreeform: false }, { text: "Something else" })).toThrow(/does not allow freeform/);
  });

  it("still validates an accompanying optionId on freeform selects", () => {
    expect(() => validateInputAnswer({ type: "select", options, allowFreeform: true }, { optionId: "other", text: "note" })).toThrow(/not one of the offered options/);
  });

  it("keeps confirmations closed to an offered optionId without text", () => {
    expect(() => validateInputAnswer({ type: "confirmation", options, allowFreeform: false }, { optionId: "abort" })).not.toThrow();
    expect(() => validateInputAnswer({ type: "confirmation", options, allowFreeform: false }, { optionId: "proceed", text: "sure" })).toThrow(/no text/);
    expect(() => validateInputAnswer({ type: "confirmation", options, allowFreeform: false }, { text: "yes" })).toThrow(/no text/);
    expect(() => validateInputAnswer({ type: "confirmation", options, allowFreeform: false }, { optionId: "other" })).toThrow(/not one of the offered options/);
  });

  it("reports invalid answers as unprocessable", () => {
    try {
      validateInputAnswer({ type: "select", options, allowFreeform: false }, { optionId: "other" });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_answer", status: 422 });
    }
  });
});

describe("exact-action binding", () => {
  it("changes when artefact order changes", async () => {
    const action = { kind: "git.merge", version: "1", audience: "github", input: { sha: "abc" } };
    const first = { id: createId(), ordinal: 0, filename: "a.pdf", mediaType: "application/pdf" as const, size: 1, sha256: "a".repeat(64) };
    const second = { ...first, id: createId(), ordinal: 1, filename: "b.pdf", sha256: "b".repeat(64) };
    const a = await freezeDigests(action, [first, second]);
    const b = await freezeDigests(action, [{ ...first, ordinal: 1 }, { ...second, ordinal: 0 }]);
    expect(a.manifestDigest).not.toBe(b.manifestDigest);
  });
});
