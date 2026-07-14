import { describe, expect, it } from "vitest";
import { createId, Id } from "./id";

describe("createId", () => {
  it("creates 12-character IDs using ASCII letters only", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(createId()).toMatch(/^[A-Za-z]{12}$/);
    }
  });

  it("uses the same format enforced by the ID contract", () => {
    expect(Id.safeParse(createId()).success).toBe(true);
    expect(Id.safeParse("abc123ABCxyz").success).toBe(false);
    expect(Id.safeParse("AbCdEfGhIjK").success).toBe(false);
  });
});
