import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApprovalRequest, CreateApproval, Decision } from "./index";
import { reviewDigest } from "./review";

describe("Decision", () => {
  it("requires non-blank feedback only when requesting changes", () => {
    expect(Decision.safeParse({ decision: "CHANGES_REQUESTED" }).success).toBe(false);
    expect(Decision.safeParse({ decision: "CHANGES_REQUESTED", comment: " \n\t " }).success).toBe(false);
    expect(Decision.safeParse({ decision: "CHANGES_REQUESTED", comment: "Split the migration." }).success).toBe(true);
    expect(Decision.safeParse({ decision: "DENIED" }).success).toBe(true);
    expect(Decision.safeParse({ decision: "APPROVED", comment: "" }).success).toBe(true);
  });

  it("reports missing feedback against the comment field", () => {
    const result = Decision.safeParse({ decision: "CHANGES_REQUESTED", comment: "" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["comment"]]);
  });

  it("rejects feedback over the length limit", () => {
    expect(Decision.safeParse({ decision: "CHANGES_REQUESTED", comment: "x".repeat(4_001) }).success).toBe(false);
  });
});

describe("review content fields", () => {
  const base = {
    action: { kind: "tool-call", toolName: "deploy", callId: "call-1", input: {} },
    explanation: "Deploy.",
  };

  it("accepts a single-line title, a Markdown document and a revision link", () => {
    const parsed = CreateApproval.parse({
      ...base,
      title: "Ship 1.2.3",
      reviewMarkdown: "# Plan\n\n| a | b |\n| - | - |",
      supersedesApprovalId: "PreviousAbcd",
    });
    expect(parsed).toMatchObject({ title: "Ship 1.2.3", supersedesApprovalId: "PreviousAbcd" });
  });

  it.each([
    ["a multi-line title", { title: "Ship\n1.2.3" }],
    ["a blank title", { title: "   " }],
    ["an overlong title", { title: "t".repeat(201) }],
    ["a blank review document", { reviewMarkdown: "\n\n" }],
    ["an overlong review document", { reviewMarkdown: "m".repeat(100_001) }],
    ["a malformed revision link", { supersedesApprovalId: "not an id" }],
  ])("rejects %s", (_name, fields) => {
    expect(CreateApproval.safeParse({ ...base, ...fields }).success).toBe(false);
  });

  it("is accepted by the one-call request contract, which stays strict about unknown fields", () => {
    const request = {
      ...base,
      expiresInSeconds: 600,
      callback: { url: "https://agent.example/callback", state: "s" },
      title: "Ship 1.2.3",
    };
    expect(ApprovalRequest.safeParse(request).success).toBe(true);
    expect(ApprovalRequest.safeParse({ ...request, reviewHtml: "<p>" }).success).toBe(false);
  });
});

describe("reviewDigest", () => {
  it("hashes the canonical versioned document, with absent fields as null", async () => {
    const expected = createHash("sha256")
      .update('{"explanation":"Deploy.","reviewMarkdown":null,"title":"Ship","v":1}')
      .digest("hex");
    expect(await reviewDigest({ title: "Ship", explanation: "Deploy." })).toBe(expected);
    expect(await reviewDigest({ title: "Ship", explanation: "Deploy.", reviewMarkdown: null })).toBe(expected);
  });

  it("changes when any reviewed field changes", async () => {
    const original = { title: "Ship", explanation: "Deploy.", reviewMarkdown: "Body" };
    const digests = new Set(await Promise.all([
      reviewDigest(original),
      reviewDigest({ ...original, title: "Ship!" }),
      reviewDigest({ ...original, explanation: "Deploy!" }),
      reviewDigest({ ...original, reviewMarkdown: "Body!" }),
      reviewDigest({ ...original, reviewMarkdown: undefined }),
      reviewDigest({ ...original, title: undefined }),
    ]));
    expect(digests.size).toBe(6);
  });

  it("does not confuse a field moved between title and document", async () => {
    expect(await reviewDigest({ title: "X", explanation: "E" }))
      .not.toBe(await reviewDigest({ reviewMarkdown: "X", explanation: "E" }));
  });
});
