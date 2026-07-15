import { createId } from "@mayi/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { clearAuthenticationAttempts, recordAuthenticationAttempt } from "./auth-rate-limit";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;

describe.sequential("public authentication abuse limits", () => {
  const identity = `auth-limit-${createId()}`;
  const hashes: string[] = [];

  afterAll(async () => {
    await clearAuthenticationAttempts(hashes);
    await database().close();
  });

  it("allows the configured attempts and rejects the next before password work", async () => {
    hashes.push(await recordAuthenticationAttempt(identity, 3));
    await expect(recordAuthenticationAttempt(identity, 3)).resolves.toBe(hashes[0]);
    await expect(recordAuthenticationAttempt(identity, 3)).resolves.toBe(hashes[0]);
    await expect(recordAuthenticationAttempt(identity, 3)).rejects.toMatchObject({ statusCode: 429 });
  });

  it("clears a successful account throttle without affecting unrelated identities", async () => {
    const successful = `auth-success-${createId()}`;
    const unrelated = `auth-unrelated-${createId()}`;
    const successfulHash = await recordAuthenticationAttempt(successful, 2);
    const unrelatedHash = await recordAuthenticationAttempt(unrelated, 2);
    hashes.push(successfulHash, unrelatedHash);
    await clearAuthenticationAttempts([successfulHash]);
    await expect(recordAuthenticationAttempt(successful, 2)).resolves.toBe(successfulHash);
    await expect(recordAuthenticationAttempt(unrelated, 2)).resolves.toBe(unrelatedHash);
    await expect(recordAuthenticationAttempt(unrelated, 2)).rejects.toMatchObject({ statusCode: 429 });
  });
});
