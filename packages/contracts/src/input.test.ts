import { describe, expect, it } from "vitest";
import {
  createId,
  Input,
  InputAnswer,
  InputRequest,
  InputResolvedEvent,
  WebhookEvent,
} from "./index";

const options = [
  { id: "proceed", label: "Proceed", style: "primary" as const },
  { id: "abort", label: "Abort", style: "danger" as const },
];

describe("input request contract", () => {
  it("accepts a text input without options or allowFreeform", () => {
    expect(InputRequest.parse({
      type: "text",
      prompt: "What should the release note say?",
      expiresInSeconds: 3_600,
      callback: { url: "https://agent.example/eve/v1/mayi/input-resolved", state: "opaque-state" },
    })).toMatchObject({ type: "text", expiresInSeconds: 3_600 });
  });

  it("rejects options and allowFreeform on a text input", () => {
    expect(InputRequest.safeParse({ type: "text", prompt: "Say something", options, expiresInSeconds: 3_600 }).success).toBe(false);
    expect(InputRequest.safeParse({ type: "text", prompt: "Say something", allowFreeform: true, expiresInSeconds: 3_600 }).success).toBe(false);
  });

  it("accepts a select input with options, freeform and an optional callback omitted", () => {
    expect(InputRequest.parse({
      type: "select",
      prompt: "Which environment?",
      options: [...options, { id: "staging", label: "Staging", description: "Pre-production" }],
      allowFreeform: true,
      expiresInSeconds: 60,
      suggestedApproverId: createId(),
    }).options).toHaveLength(3);
  });

  it("requires options for select inputs and unique option ids", () => {
    expect(InputRequest.safeParse({ type: "select", prompt: "Pick one", expiresInSeconds: 3_600 }).success).toBe(false);
    expect(InputRequest.safeParse({
      type: "select",
      prompt: "Pick one",
      options: [options[0], { ...options[1], id: "proceed" }],
      expiresInSeconds: 3_600,
    }).success).toBe(false);
  });

  it("accepts a confirmation input with exactly two options", () => {
    expect(InputRequest.parse({
      type: "confirmation",
      prompt: "Merge the release branch?",
      options,
      expiresInSeconds: 3_600,
    }).type).toBe("confirmation");
  });

  it("rejects confirmations without exactly two options or with freeform", () => {
    expect(InputRequest.safeParse({ type: "confirmation", prompt: "Merge?", options: [options[0]], expiresInSeconds: 3_600 }).success).toBe(false);
    expect(InputRequest.safeParse({ type: "confirmation", prompt: "Merge?", options, allowFreeform: true, expiresInSeconds: 3_600 }).success).toBe(false);
  });

  it("bounds the expiry like approval requests", () => {
    expect(InputRequest.safeParse({ type: "text", prompt: "Say something", expiresInSeconds: 59 }).success).toBe(false);
    expect(InputRequest.safeParse({ type: "text", prompt: "Say something", expiresInSeconds: 7 * 24 * 60 * 60 + 1 }).success).toBe(false);
  });
});

describe("input answer contract", () => {
  it("accepts an optionId, text, or both", () => {
    expect(InputAnswer.parse({ optionId: "proceed" })).toEqual({ optionId: "proceed" });
    expect(InputAnswer.parse({ text: "Ship it" })).toEqual({ text: "Ship it" });
    expect(InputAnswer.parse({ optionId: "other", text: "Ship it" }).text).toBe("Ship it");
  });

  it("rejects an empty answer", () => {
    expect(InputAnswer.safeParse({}).success).toBe(false);
    expect(InputAnswer.safeParse({ text: "" }).success).toBe(false);
  });
});

describe("input resource contract", () => {
  it("accepts an answered input with its attestation", () => {
    expect(Input.parse({
      id: createId(),
      type: "select",
      prompt: "Which environment?",
      options,
      allowFreeform: false,
      state: "ANSWERED",
      answer: { optionId: "proceed" },
      attestation: "compact-jws",
      respondentId: createId(),
      agentId: createId(),
      createdAt: "2026-07-15T00:00:00.000Z",
      expiresAt: "2026-07-16T00:00:00.000Z",
      answeredAt: "2026-07-15T01:00:00.000Z",
      cancelledAt: null,
    }).state).toBe("ANSWERED");
  });

  it("accepts a pending text input with null option and answer fields", () => {
    expect(Input.parse({
      id: createId(),
      type: "text",
      prompt: "What should the release note say?",
      options: null,
      allowFreeform: false,
      state: "PENDING",
      answer: null,
      attestation: null,
      respondentId: null,
      agentId: createId(),
      createdAt: "2026-07-15T00:00:00.000Z",
      expiresAt: "2026-07-16T00:00:00.000Z",
      answeredAt: null,
      cancelledAt: null,
    }).answer).toBeNull();
  });
});

describe("input resolution event contract", () => {
  const base = {
    id: createId(),
    type: "input.resolved" as const,
    version: 1 as const,
    inputId: createId(),
    state: "opaque-state",
    occurredAt: "2026-07-15T00:00:00.000Z",
  };

  it("accepts an answered event with respondent, answer and attestation", () => {
    expect(InputResolvedEvent.parse({
      ...base,
      status: "answered",
      respondent: { id: createId(), email: "human@example.test" },
      answer: { optionId: "proceed" },
      attestation: "compact-jws",
    }).status).toBe("answered");
  });

  it("requires the respondent and attestation on answered events", () => {
    expect(InputResolvedEvent.safeParse({ ...base, status: "answered", answer: { text: "Ship it" } }).success).toBe(false);
  });

  it("does not allow answers on expired or cancelled events", () => {
    expect(InputResolvedEvent.safeParse({ ...base, status: "expired", answer: { text: "late" } }).success).toBe(false);
    expect(InputResolvedEvent.parse({ ...base, status: "cancelled" }).status).toBe("cancelled");
  });
});

describe("webhook event union", () => {
  it("parses both approval and input resolutions", () => {
    const approval = WebhookEvent.parse({
      id: createId(),
      type: "approval.resolved",
      version: 1,
      approvalId: createId(),
      state: "opaque-state",
      occurredAt: "2026-07-15T00:00:00.000Z",
      status: "expired",
    });
    expect(approval.type).toBe("approval.resolved");

    const input = WebhookEvent.parse({
      id: createId(),
      type: "input.resolved",
      version: 1,
      inputId: createId(),
      state: "opaque-state",
      occurredAt: "2026-07-15T00:00:00.000Z",
      status: "expired",
    });
    expect(input.type).toBe("input.resolved");
  });
});
