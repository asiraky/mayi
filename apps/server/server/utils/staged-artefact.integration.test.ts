import { createId } from "@mayi/contracts";
import type { ObjectStore } from "@mayi/storage";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import stageArtefact from "../api/approvals/request/artefacts/[ordinal].post";
import { tokenHash } from "./crypto";
import { configureEdgeRuntime, database } from "./runtime";
import { cleanupExpiredStagedArtefacts } from "./staged-artefact-cleanup";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;

class MemoryObjectStore implements ObjectStore {
  readonly values = new Map<string, { bytes: Uint8Array; mediaType: string }>();

  async putImmutable(key: string, bytes: Uint8Array, mediaType: string): Promise<void> {
    if (await this.putIfAbsent(key, bytes, mediaType) === "exists") throw new Error("Object already exists");
  }

  async putIfAbsent(key: string, bytes: Uint8Array, mediaType: string): Promise<"created" | "exists"> {
    if (this.values.has(key)) return "exists";
    this.values.set(key, { bytes: bytes.slice(), mediaType });
    return "created";
  }

  async get(key: string): Promise<{ bytes: Uint8Array; mediaType?: string }> {
    const value = this.values.get(key);
    if (!value) throw new Error("Object not found");
    return { bytes: value.bytes.slice(), mediaType: value.mediaType };
  }

  async delete(key: string): Promise<void> { this.values.delete(key); }
}

const token = `stage-token-${createId()}`;
const ids = { workspace: createId(), user: createId(), agent: createId() };
const objectStore = new MemoryObjectStore();
configureEdgeRuntime({ objectStore });

const router = createRouter();
router.post("/api/approvals/request/artefacts/:ordinal", stageArtefact);
const app = createApp();
app.use(router);
const handle = toWebHandler(app);

function post(key: string, bytes: Uint8Array, options: { mediaType?: string; ordinal?: number } = {}) {
  return handle(new Request(`http://mayi.test/api/approvals/request/artefacts/${options.ordinal ?? 0}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": options.mediaType ?? "image/png",
      "idempotency-key": key,
      "x-mayi-filename": "preview.png",
    },
    body: bytes as unknown as BodyInit,
  }));
}

describe.sequential("POST /api/approvals/request/artefacts/:ordinal", () => {
  beforeAll(async () => {
    await database().sql`
      insert into users (id, email, display_name, password_hash)
      values (${ids.user}, ${`staged-${ids.user}@example.com`}, 'Staged artefact owner', 'unused')
    `;
    await database().sql`insert into workspaces (id, name) values (${ids.workspace}, 'Staged artefact integration')`;
    await database().sql`
      insert into agents (id, workspace_id, name, scopes, credential_hash, created_by)
      values (${ids.agent}, ${ids.workspace}, 'Staging agent', ${["approval:create"]}, ${await tokenHash(token)}, ${ids.user})
    `;
  });

  afterAll(async () => {
    await database().sql`delete from workspaces where id = ${ids.workspace}`;
    await database().sql`delete from users where id = ${ids.user}`;
    await database().close();
  });

  it("collapses concurrent exact uploads and returns the bound-stable ID", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const responses = await Promise.all([post("same-upload", bytes), post("same-upload", bytes)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ id: string }>));
    expect(bodies[0]!.id).toBe(bodies[1]!.id);
    expect(objectStore.values.size).toBe(1);
    const [row] = await database().sql`
      select state, approval_id, request_key, upload_ordinal from artefacts where id = ${bodies[0]!.id}
    `;
    expect(row).toMatchObject({ state: "READY", approval_id: null, request_key: "same-upload", upload_ordinal: 0 });
  });

  it("rejects changed bytes under the same request key and ordinal", async () => {
    const changed = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);
    const response = await post("same-upload", changed);
    expect(response.status).toBe(409);
    expect(objectStore.values.size).toBe(1);
  });

  it("rejects spoofed media types before reserving storage", async () => {
    const response = await post("spoofed", new TextEncoder().encode("%PDF-1.7"));
    expect(response.status).toBe(415);
    const rows = await database().sql`
      select id from artefacts where workspace_id = ${ids.workspace} and request_key = 'spoofed'
    `;
    expect(rows).toHaveLength(0);
  });

  it("deletes expired unbound stages from both storage and the database", async () => {
    const artefactId = createId();
    const objectKey = `${ids.workspace}/expired`;
    await objectStore.putImmutable(objectKey, new Uint8Array([1]), "application/pdf");
    await database().sql`
      insert into artefacts (
        id, workspace_id, agent_id, request_key, upload_ordinal, upload_payload_hash,
        expires_at, object_key, filename, media_type, size, sha256, state
      ) values (
        ${artefactId}, ${ids.workspace}, ${ids.agent}, 'expired-stage', 0, ${"e".repeat(64)},
        now() - interval '1 minute', ${objectKey}, 'expired.pdf', 'application/pdf', 1, ${"f".repeat(64)}, 'READY'
      )
    `;

    await expect(cleanupExpiredStagedArtefacts()).resolves.toBeGreaterThanOrEqual(1);
    expect(objectStore.values.has(objectKey)).toBe(false);
    const rows = await database().sql`select id from artefacts where id = ${artefactId}`;
    expect(rows).toHaveLength(0);
  });
});
