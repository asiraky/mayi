import { sha256, type Artefact } from "@mayi/contracts";
import type { ObjectStore } from "@mayi/storage";

export const ARTEFACT_MEDIA_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type ArtefactMediaType = Artefact["mediaType"];
export const MAX_ARTEFACT_BYTES = 25 * 1024 * 1024;

export function detectArtefactMediaType(bytes: Uint8Array): ArtefactMediaType | undefined {
  if (
    bytes.length >= 5
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d
  ) return "application/pdf";
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50
  ) return "image/webp";
  return undefined;
}

export type StoredArtefactExpectation = {
  objectKey: string;
  mediaType: ArtefactMediaType;
  size: number;
  sha256: string;
};

/** Verifies immutable storage before an upload replay or final approval claim trusts its row. */
export async function storedArtefactMatches(
  store: ObjectStore,
  expected: StoredArtefactExpectation,
): Promise<boolean> {
  try {
    const stored = await store.get(expected.objectKey);
    return stored.bytes.byteLength === expected.size
      && detectArtefactMediaType(stored.bytes) === expected.mediaType
      && (stored.mediaType === undefined || stored.mediaType === expected.mediaType)
      && await sha256(stored.bytes) === expected.sha256;
  } catch {
    return false;
  }
}
