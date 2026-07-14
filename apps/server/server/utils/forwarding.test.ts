import { compactVerify, importJWK } from "jose";
import { describe, expect, it } from "vitest";
import { canonicalize } from "@mayi/contracts";
import { signWebhook, validateOutboundUrl } from "./forwarding";
import { signingKeys } from "./signer";

describe("forwarding security", () => {
  it("rejects private and insecure callback targets", async () => {
    await expect(validateOutboundUrl("http://example.com/hook")).rejects.toThrow(/HTTPS/);
    await expect(validateOutboundUrl("https://127.0.0.1/hook")).rejects.toThrow(/public/);
    await expect(validateOutboundUrl("https://service.local/hook")).rejects.toThrow(/public/);
  });

  it("signs the exact canonical webhook payload", async () => {
    const payload = { z: 2, a: "request" };
    const signature = await signWebhook(payload);
    const key = await importJWK((await signingKeys()).publicJwk, "EdDSA");
    const verified = await compactVerify(signature, key);
    expect(new TextDecoder().decode(verified.payload)).toBe(canonicalize(payload));
  });
});
