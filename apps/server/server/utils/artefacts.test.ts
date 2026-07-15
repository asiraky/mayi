import { describe, expect, it } from "vitest";
import { detectArtefactMediaType } from "./artefacts";

describe("detectArtefactMediaType", () => {
  it.each([
    ["application/pdf", new TextEncoder().encode("%PDF-1.7")],
    ["image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])],
    ["image/webp", new TextEncoder().encode("RIFF0000WEBP")],
  ] as const)("detects %s signatures", (mediaType, bytes) => {
    expect(detectArtefactMediaType(bytes)).toBe(mediaType);
  });

  it("rejects content without a supported signature", () => {
    expect(detectArtefactMediaType(new TextEncoder().encode("not an image"))).toBeUndefined();
  });
});
