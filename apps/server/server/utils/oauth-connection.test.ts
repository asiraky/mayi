import { describe, expect, it } from "vitest";
import { parseConnectionId, parseConnectionLabel } from "./oauth-connection";

describe("parseConnectionLabel", () => {
  it.each([undefined, null, "", "   "])("treats %j as no label", (value) => {
    expect(parseConnectionLabel(value)).toBeNull();
  });

  it("trims and neutralises control characters", () => {
    const nul = String.fromCharCode(0);
    expect(parseConnectionLabel(`  HARNESST —\nledger${nul} `)).toBe("HARNESST — ledger");
  });

  it("accepts the longest allowed label and rejects one character more", () => {
    expect(parseConnectionLabel("a".repeat(100))).toHaveLength(100);
    expect(() => parseConnectionLabel("a".repeat(101))).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });
});

describe("parseConnectionId", () => {
  it.each([undefined, null, ""])("treats %j as a new connection", (value) => {
    expect(parseConnectionId(value)).toBeNull();
  });

  it("passes a well-formed id through", () => {
    expect(parseConnectionId("AbCdEfGhIjKl")).toBe("AbCdEfGhIjKl");
  });

  it.each(["short", "AbCdEfGhIjK1", "AbCdEfGhIjKl'; --"])("rejects malformed id %j", (value) => {
    expect(() => parseConnectionId(value)).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });
});
