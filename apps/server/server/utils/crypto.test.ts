import { describe, expect, it } from "vitest";
import { passwordHash, verifyPassword } from "./crypto";

describe("password hashing", () => {
  it("uses the Cloudflare-supported PBKDF2 ceiling", async () => {
    const encoded = await passwordHash("correct horse battery staple", "fixed-salt");

    expect(encoded).toMatch(/^pbkdf2-sha256\$100000\$fixed-salt\$/);
    await expect(verifyPassword("correct horse battery staple", encoded)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", encoded)).resolves.toBe(false);
  });
});
