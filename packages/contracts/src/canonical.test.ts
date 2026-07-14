import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalize } from "./canonical";

describe("canonical JSON", () => {
  it("sorts object keys recursively without reordering arrays", () => {
    expect(canonicalize({ z: 1, a: [{ y: 2, x: 1 }] })).toBe('{"a":[{"x":1,"y":2}],"z":1}');
  });

  it("produces a stable SHA-256 digest", async () => {
    expect(await canonicalDigest({ b: 2, a: 1 })).toBe(await canonicalDigest({ a: 1, b: 2 }));
  });
});
