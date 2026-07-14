import { describe, expect, it } from "vitest";
import { decisionTransition, freezeDigests, validateActionForEnforcement, validateSuggestedApprover } from "./index";

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
    expect(() => validateActionForEnforcement({ kind: "custom.note", version: "1", audience: "test", parameters: {} }, "verified")).toThrow(/registered exact-action/);
  });
  it("allows unknown actions only as cooperative records", () => {
    expect(() => validateActionForEnforcement({ kind: "custom.note", version: "1", audience: "test", parameters: {} }, "cooperative")).not.toThrow();
  });
});

describe("exact-action binding", () => {
  it("changes when artefact order changes", async () => {
    const action = { kind: "git.merge", version: "1", audience: "github", parameters: { sha: "abc" } };
    const first = { id: crypto.randomUUID(), ordinal: 0, filename: "a.pdf", mediaType: "application/pdf" as const, size: 1, sha256: "a".repeat(64) };
    const second = { ...first, id: crypto.randomUUID(), ordinal: 1, filename: "b.pdf", sha256: "b".repeat(64) };
    const a = await freezeDigests(action, [first, second]);
    const b = await freezeDigests(action, [{ ...first, ordinal: 1 }, { ...second, ordinal: 0 }]);
    expect(a.manifestDigest).not.toBe(b.manifestDigest);
  });
});
