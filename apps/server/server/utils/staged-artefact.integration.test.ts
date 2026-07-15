import { createId } from "@mayi/contracts";
import type { ObjectStore } from "@mayi/storage";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import downloadArtefact from "../api/approvals/[id]/artefacts/[artefactId].get";
import uploadDraftArtefact from "../api/approvals/[id]/artefacts.post";
import stageArtefact from "../api/approvals/request/artefacts/[ordinal].post";
import { MAX_ARTEFACT_BYTES } from "./artefacts";
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
router.post("/api/approvals/:id/artefacts", uploadDraftArtefact);
router.get("/api/approvals/:id/artefacts/:artefactId", downloadArtefact);
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

function postStream(key: string, chunks: Uint8Array[], cancel: () => void = () => undefined) {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel,
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    duplex: "half",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/pdf",
      "idempotency-key": key,
      "x-mayi-filename": "stream.pdf",
    },
    body,
  };
  return handle(new Request("http://mayi.test/api/approvals/request/artefacts/0", init));
}

function postDraft(approvalId: string, bytes: Uint8Array, mediaType: string) {
  return handle(new Request(`http://mayi.test/api/approvals/${approvalId}/artefacts?filename=evidence.bin`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": mediaType },
    body: bytes as unknown as BodyInit,
  }));
}

async function insertExpiredStage(suffix: string): Promise<{ artefactId: string; objectKey: string }> {
  const artefactId = createId();
  const objectKey = `${ids.workspace}/expired-${suffix}`;
  await objectStore.putImmutable(objectKey, new TextEncoder().encode("%PDF-x"), "application/pdf");
  await database().sql`
    insert into artefacts (
      id, workspace_id, agent_id, request_key, upload_ordinal, upload_payload_hash,
      expires_at, object_key, filename, media_type, size, sha256, state
    ) values (
      ${artefactId}, ${ids.workspace}, ${ids.agent}, ${`expired-${suffix}`}, 0, ${"e".repeat(64)},
      now() - interval '1 minute', ${objectKey}, 'expired.pdf', 'application/pdf', 6, ${"f".repeat(64)}, 'READY'
    )
  `;
  return { artefactId, objectKey };
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
      values (${ids.agent}, ${ids.workspace}, 'Staging agent', ${["approval:create", "approval:read"]}, ${await tokenHash(token)}, ${ids.user})
    `;
  });

  afterAll(async () => {
    await database().sql`drop trigger if exists test_fail_staged_artefact_delete on artefacts`;
    await database().sql`drop function if exists test_fail_staged_artefact_delete()`;
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

  it.each([
    ["application/pdf", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/png", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])],
    ["image/jpeg", new TextEncoder().encode("RIFF0000WEBP")],
    ["image/webp", new TextEncoder().encode("%PDF-1.7")],
  ])("rejects %s labels with a different supported signature before staging", async (mediaType, bytes) => {
    const key = `spoofed-${mediaType}`;
    const response = await post(key, bytes, { mediaType });
    expect(response.status).toBe(415);
    const rows = await database().sql`
      select id from artefacts where workspace_id = ${ids.workspace} and request_key = ${key}
    `;
    expect(rows).toHaveLength(0);
  });

  it("accepts a chunked staged artefact exactly at the 25 MiB boundary", async () => {
    const body = new Uint8Array(MAX_ARTEFACT_BYTES);
    body.set(new TextEncoder().encode("%PDF-1.7"));
    const response = await postStream("stream-boundary", [
      body.subarray(0, 8),
      body.subarray(8),
    ]);
    expect(response.status).toBe(200);
    const uploaded = await response.json() as { size: number };
    expect(uploaded.size).toBe(MAX_ARTEFACT_BYTES);
  });

  it("rejects a chunked staged artefact immediately after it crosses 25 MiB", async () => {
    const first = new Uint8Array(MAX_ARTEFACT_BYTES);
    first.set(new TextEncoder().encode("%PDF-1.7"));
    const response = await postStream("stream-oversize", [first, new Uint8Array([1])]);
    expect(response.status).toBe(413);
    expect(await database().sql`
      select id from artefacts where workspace_id = ${ids.workspace} and request_key = 'stream-oversize'
    `).toHaveLength(0);
  });

  it("recreates a missing object before trusting an exact READY upload replay", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);
    const first = await post("restore-ready", bytes, { mediaType: "image/jpeg" });
    const uploaded = await first.json() as { id: string };
    const [row] = await database().sql`select object_key from artefacts where id = ${uploaded.id}`;
    const objectKey = String(row!.object_key);
    objectStore.values.delete(objectKey);

    const replay = await post("restore-ready", bytes, { mediaType: "image/jpeg" });
    expect(replay.status).toBe(200);
    expect(objectStore.values.get(objectKey)?.bytes).toEqual(bytes);
  });

  it("rejects an exact READY replay when immutable storage contains different bytes", async () => {
    const bytes = new TextEncoder().encode("RIFF0000WEBPpayload");
    const first = await post("corrupt-ready", bytes, { mediaType: "image/webp" });
    const uploaded = await first.json() as { id: string };
    const [row] = await database().sql`select object_key from artefacts where id = ${uploaded.id}`;
    objectStore.values.set(String(row!.object_key), {
      bytes: new TextEncoder().encode("RIFF0000WEBPchanged"),
      mediaType: "image/webp",
    });

    expect((await post("corrupt-ready", bytes, { mediaType: "image/webp" })).status).toBe(409);
  });

  it.each([
    ["application/pdf", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/png", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])],
    ["image/jpeg", new TextEncoder().encode("RIFF0000WEBP")],
    ["image/webp", new TextEncoder().encode("%PDF-1.7")],
  ])("rejects %s labels with a different supported signature on the draft path", async (mediaType, bytes) => {
    const approvalId = createId();
    await database().sql`
      insert into approvals (id, workspace_id, agent_id, action, explanation, enforcement, expires_at)
      values (${approvalId}, ${ids.workspace}, ${ids.agent},
        ${JSON.stringify({ kind: "tool-call", toolName: "draft", callId: createId(), input: {} })}::jsonb,
        'Draft upload validation', 'cooperative', now() + interval '1 hour')
    `;
    const objectCount = objectStore.values.size;

    const response = await postDraft(approvalId, bytes, mediaType);

    expect(response.status).toBe(415);
    expect(objectStore.values.size).toBe(objectCount);
    expect(await database().sql`select id from artefacts where approval_id = ${approvalId}`).toHaveLength(0);
  });

  it("accepts matching signatures on the retained draft upload path", async () => {
    const approvalId = createId();
    await database().sql`
      insert into approvals (id, workspace_id, agent_id, action, explanation, enforcement, expires_at)
      values (${approvalId}, ${ids.workspace}, ${ids.agent},
        ${JSON.stringify({ kind: "tool-call", toolName: "draft", callId: createId(), input: {} })}::jsonb,
        'Draft upload validation', 'cooperative', now() + interval '1 hour')
    `;
    const bytes = new TextEncoder().encode("%PDF-1.7");
    const response = await postDraft(approvalId, bytes, "application/pdf");
    expect(response.status).toBe(200);
    const uploaded = await response.json() as { id: string; mediaType: string };
    expect(uploaded.mediaType).toBe("application/pdf");
    expect(await database().sql`select id from artefacts where id = ${uploaded.id}`).toHaveLength(1);
    const download = await handle(new Request(
      `http://mayi.test/api/approvals/${approvalId}/artefacts/${uploaded.id}`,
      { headers: { authorization: `Bearer ${token}` } },
    ));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-security-policy")).toContain("sandbox");
    expect(download.headers.get("cache-control")).toBe("private, no-store");
  });

  it("deletes expired unbound stages from both storage and the database", async () => {
    const { artefactId, objectKey } = await insertExpiredStage("ordinary");

    await expect(cleanupExpiredStagedArtefacts()).resolves.toBeGreaterThanOrEqual(1);
    expect(objectStore.values.has(objectKey)).toBe(false);
    const rows = await database().sql`select id from artefacts where id = ${artefactId}`;
    expect(rows).toHaveLength(0);
  });

  it("resumes cleanup after a crash immediately after the DELETING commit", async () => {
    const { artefactId, objectKey } = await insertExpiredStage("after-mark");
    await expect(cleanupExpiredStagedArtefacts(1, {
      afterMarked: () => { throw new Error("simulated crash after mark"); },
    })).rejects.toThrow("simulated crash after mark");
    const [marked] = await database().sql`select state, approval_id from artefacts where id = ${artefactId}`;
    expect(marked).toMatchObject({ state: "DELETING", approval_id: null });
    expect(objectStore.values.has(objectKey)).toBe(true);
    expect((await post("expired-after-mark", new TextEncoder().encode("%PDF-x"), {
      mediaType: "application/pdf",
    })).status).toBe(409);

    await expect(cleanupExpiredStagedArtefacts(1)).resolves.toBe(1);
    expect(objectStore.values.has(objectKey)).toBe(false);
    expect(await database().sql`select id from artefacts where id = ${artefactId}`).toHaveLength(0);
  });

  it("resumes cleanup after object deletion but before row deletion", async () => {
    const { artefactId, objectKey } = await insertExpiredStage("after-object");
    await expect(cleanupExpiredStagedArtefacts(1, {
      afterObjectDeleted: () => { throw new Error("simulated crash after object delete"); },
    })).rejects.toThrow("simulated crash after object delete");
    expect(objectStore.values.has(objectKey)).toBe(false);
    const [marked] = await database().sql`select state from artefacts where id = ${artefactId}`;
    expect(marked!.state).toBe("DELETING");

    await expect(cleanupExpiredStagedArtefacts(1)).resolves.toBe(1);
    expect(await database().sql`select id from artefacts where id = ${artefactId}`).toHaveLength(0);
  });

  it("resumes a DELETING row after database row deletion fails", async () => {
    const { artefactId, objectKey } = await insertExpiredStage("delete-failure");
    await database().sql`
      create function test_fail_staged_artefact_delete() returns trigger language plpgsql as $$
      begin
        raise exception 'forced staged artefact row deletion failure';
      end
      $$
    `;
    await database().sql`
      create trigger test_fail_staged_artefact_delete before delete on artefacts
      for each row execute function test_fail_staged_artefact_delete()
    `;
    try {
      await expect(cleanupExpiredStagedArtefacts(1)).rejects.toThrow("forced staged artefact row deletion failure");
    } finally {
      await database().sql`drop trigger test_fail_staged_artefact_delete on artefacts`;
      await database().sql`drop function test_fail_staged_artefact_delete()`;
    }
    expect(objectStore.values.has(objectKey)).toBe(false);
    const [marked] = await database().sql`select state from artefacts where id = ${artefactId}`;
    expect(marked!.state).toBe("DELETING");

    await expect(cleanupExpiredStagedArtefacts(1)).resolves.toBe(1);
    expect(await database().sql`select id from artefacts where id = ${artefactId}`).toHaveLength(0);
  });
});
