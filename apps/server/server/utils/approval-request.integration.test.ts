import { createId, ID_PATTERN, type ApprovalRequest } from "@mayi/contracts";
import { createApp, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import requestApproval from "../api/approvals/request.post";
import { tokenHash } from "./crypto";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;

const CALLBACK_A = "https://8.8.8.8/eve/v1/mayi/approval-resolved";
const CALLBACK_B = "https://1.1.1.1/eve/v1/mayi/approval-resolved";
const PRIVATE_CALLBACK = "https://127.0.0.1/eve/v1/mayi/approval-resolved";
const TOKENS = {
  createA: `test-create-a-${createId()}`,
  createB: `test-create-b-${createId()}`,
  readOnly: `test-read-only-${createId()}`,
};

const ids = {
  workspace: createId(),
  user: createId(),
  clientA: createId(),
  clientB: createId(),
  agentA: createId(),
  agentB: createId(),
  readOnlyAgent: createId(),
  forwardingDestination: createId(),
  forwardingRule: createId(),
};

const baseInput: ApprovalRequest = {
  action: {
    kind: "tool-call",
    toolName: "deploy_release",
    callId: "eve-call-42",
    input: { version: "1.2.3", environment: "production" },
  },
  explanation: "Deploy version 1.2.3 to production.",
  suggestedApproverId: ids.user,
  expiresInSeconds: 3_600,
  callback: {
    url: CALLBACK_A,
    state: "v1.opaque/adapter+ciphertext_ß_🔒",
  },
};

const app = createApp();
app.use("/api/approvals/request", requestApproval);
const handle = toWebHandler(app);

function post(input: unknown, options: { token?: string; key?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.key) headers["idempotency-key"] = options.key;
  return handle(new Request("http://mayi.test/api/approvals/request", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  }));
}

describe.sequential("POST /api/approvals/request", () => {
  beforeAll(async () => {
    const sql = database().sql;
    await sql`
      insert into users (id, email, display_name, password_hash)
      values (${ids.user}, ${`approval-request-${ids.user}@example.com`}, 'Approval Request Owner', 'unused')
    `;
    await sql`insert into workspaces (id, name) values (${ids.workspace}, 'Approval request integration')`;
    await sql`
      insert into memberships (workspace_id, user_id, role)
      values (${ids.workspace}, ${ids.user}, 'OWNER')
    `;
    await sql`
      insert into oauth_clients (id, name, redirect_uris, approval_callback_uris, registration_ip_hash)
      values (
        ${ids.clientA}, 'Client A', ${["https://eden-a.example/oauth/callback"]},
        ${[CALLBACK_A, PRIVATE_CALLBACK]}, ${"a".repeat(64)}
      ), (
        ${ids.clientB}, 'Client B', ${["https://eden-b.example/oauth/callback"]},
        ${[CALLBACK_B]}, ${"b".repeat(64)}
      )
    `;
    await sql`
      insert into agents (id, workspace_id, name, client_id, scopes, credential_hash, created_by)
      values
        (${ids.agentA}, ${ids.workspace}, 'Create A', ${ids.clientA}, ${["approval:create"]}, ${await tokenHash(TOKENS.createA)}, ${ids.user}),
        (${ids.agentB}, ${ids.workspace}, 'Create B', ${ids.clientB}, ${["approval:create"]}, ${await tokenHash(TOKENS.createB)}, ${ids.user}),
        (${ids.readOnlyAgent}, ${ids.workspace}, 'Read only', ${ids.clientA}, ${["approval:read"]}, ${await tokenHash(TOKENS.readOnly)}, ${ids.user})
    `;
    await sql`
      insert into forwarding_destinations (
        id, workspace_id, type, name, endpoint, mode, verified_at
      ) values (
        ${ids.forwardingDestination}, ${ids.workspace}, 'WEBHOOK', 'Pending webhook',
        'https://8.8.4.4/pending', 'notify_only', now()
      )
    `;
    await sql`
      insert into forwarding_rules (id, workspace_id, destination_id, action_kind)
      values (${ids.forwardingRule}, ${ids.workspace}, ${ids.forwardingDestination}, 'deploy_release')
    `;
  });

  afterAll(async () => {
    const sql = database().sql;
    await sql`drop trigger if exists test_fail_pending_job on jobs`;
    await sql`drop function if exists test_fail_pending_job()`;
    await sql`delete from workspaces where id = ${ids.workspace}`;
    await sql`delete from oauth_clients where id in (${ids.clientA}, ${ids.clientB})`;
    await sql`delete from users where id = ${ids.user}`;
    await database().close();
  });

  it("returns a complete sealed PENDING approval immediately and preserves opaque state", async () => {
    const spies = ["debug", "error", "info", "log", "warn"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined));
    const startedAt = performance.now();
    const response = await Promise.race([
      post(baseInput, { token: TOKENS.createA, key: "pending-immediately" }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("request waited for a human")), 1_000)),
    ]);
    const elapsed = performance.now() - startedAt;
    const approval = await response.json() as Record<string, unknown>;
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }

    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(1_000);
    expect(approval).toMatchObject({
      state: "PENDING",
      action: baseInput.action,
      explanation: baseInput.explanation,
      enforcement: "cooperative",
      artefacts: [],
      decidedAt: null,
      approverId: null,
    });
    expect(approval.id).toMatch(ID_PATTERN);
    expect(approval.sealedAt).toEqual(expect.any(String));
    expect(approval.actionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(approval.manifestDigest).toMatch(/^[a-f0-9]{64}$/);

    const approvalId = String(approval.id);
    const [callback] = await database().sql`
      select id, url, state from approval_callbacks where approval_id = ${approvalId}
    `;
    expect(String(callback!.id)).toMatch(ID_PATTERN);
    expect(callback).toMatchObject({ url: CALLBACK_A, state: baseInput.callback.state });
    const eligible = await database().sql`
      select user_id from eligible_approvers where approval_id = ${approvalId}
    `;
    expect(eligible.map((row) => String(row.user_id))).toEqual([ids.user]);
    const [job] = await database().sql`
      select payload from jobs where type = 'push.approval_pending' and dedupe_key = ${approvalId}
    `;
    expect(job!.payload).toEqual({ approvalId });
    const queued = await database().sql`
      select type, payload from jobs where payload->>'approvalId' = ${approvalId} order by type
    `;
    expect(queued.map((row) => String(row.type))).toEqual([
      "push.approval_pending",
      "webhook.approval_pending",
    ]);
    const storedMetadata = await database().sql`
      select metadata from audit_events where subject_id = ${approvalId}
      union all
      select response as metadata from idempotency_keys
      where operation = 'approval.request' and response->>'id' = ${approvalId}
    `;
    expect(JSON.stringify(storedMetadata)).not.toContain(baseInput.callback.state);
    expect(JSON.stringify(queued)).not.toContain(baseInput.callback.state);
  });

  it("returns the original approval for identical reuse and rejects different content", async () => {
    const first = await post(baseInput, { token: TOKENS.createA, key: "stable-reuse" });
    const original = await first.json() as { id: string };
    const replay = await post(baseInput, { token: TOKENS.createA, key: "stable-reuse" });
    const replayed = await replay.json() as { id: string };
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replayed.id).toBe(original.id);

    const randomizedStateReplay = await post({
      ...baseInput,
      callback: { ...baseInput.callback, state: "different-randomized-ciphertext" },
    }, { token: TOKENS.createA, key: "stable-reuse" });
    expect(randomizedStateReplay.status).toBe(200);
    expect((await randomizedStateReplay.json() as { id: string }).id).toBe(original.id);
    const [storedCallback] = await database().sql`
      select state from approval_callbacks where approval_id = ${original.id}
    `;
    expect(storedCallback!.state).toBe(baseInput.callback.state);

    const changed = await post({ ...baseInput, explanation: "Different content." }, {
      token: TOKENS.createA,
      key: "stable-reuse",
    });
    expect(changed.status).toBe(409);
    const countRows = await database().sql`
      select count(*)::int as count from approvals where id = ${original.id}
    `;
    expect(Number(countRows[0]!.count)).toBe(1);
  });

  it("collapses concurrent identical requests to one approval", async () => {
    const responses = await Promise.all(Array.from({ length: 4 }, () =>
      post(baseInput, { token: TOKENS.createA, key: "concurrent-reuse" })));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    const approvals = await Promise.all(responses.map((response) => response.json() as Promise<{ id: string }>));
    expect(new Set(approvals.map(({ id }) => id)).size).toBe(1);
  });

  it("atomically claims ordered request-bound artefacts into the pending manifest", async () => {
    const artefactIds = [createId(), createId()] as const;
    await database().sql`
      insert into artefacts (
        id, workspace_id, agent_id, request_key, upload_ordinal, upload_payload_hash,
        expires_at, object_key, filename, media_type, size, sha256, state
      ) values (
        ${artefactIds[0]}, ${ids.workspace}, ${ids.agentA}, 'staged-evidence', 0, ${"1".repeat(64)},
        now() + interval '1 hour', ${`${ids.workspace}/stage/0`}, 'plan.pdf', 'application/pdf', 8, ${"a".repeat(64)}, 'READY'
      ), (
        ${artefactIds[1]}, ${ids.workspace}, ${ids.agentA}, 'staged-evidence', 1, ${"2".repeat(64)},
        now() + interval '1 hour', ${`${ids.workspace}/stage/1`}, 'preview.png', 'image/png', 8, ${"b".repeat(64)}, 'READY'
      )
    `;

    const response = await post({ ...baseInput, artefactIds: [...artefactIds] }, {
      token: TOKENS.createA,
      key: "staged-evidence",
    });
    const approval = await response.json() as { id: string; artefacts: Array<{ id: string; ordinal: number }> };
    expect(response.status).toBe(200);
    expect(approval.artefacts).toEqual([
      expect.objectContaining({ id: artefactIds[0], ordinal: 0 }),
      expect.objectContaining({ id: artefactIds[1], ordinal: 1 }),
    ]);
    const claimed = await database().sql`
      select id, approval_id from artefacts where id in ${database().sql(artefactIds)} order by upload_ordinal
    `;
    expect(claimed.map((row) => String(row.approval_id))).toEqual([approval.id, approval.id]);
    const manifest = await database().sql`
      select artefact_id, ordinal from approval_artefacts where approval_id = ${approval.id} order by ordinal
    `;
    expect(manifest.map((row) => [String(row.artefact_id), Number(row.ordinal)])).toEqual([
      [artefactIds[0], 0],
      [artefactIds[1], 1],
    ]);
  });

  it("rejects artefacts staged under a different request key", async () => {
    const artefactId = createId();
    await database().sql`
      insert into artefacts (
        id, workspace_id, agent_id, request_key, upload_ordinal, upload_payload_hash,
        expires_at, object_key, filename, media_type, size, sha256, state
      ) values (
        ${artefactId}, ${ids.workspace}, ${ids.agentA}, 'different-request', 0, ${"3".repeat(64)},
        now() + interval '1 hour', ${`${ids.workspace}/stage/cross`}, 'plan.pdf', 'application/pdf', 8, ${"c".repeat(64)}, 'READY'
      )
    `;
    const response = await post({ ...baseInput, artefactIds: [artefactId] }, {
      token: TOKENS.createA,
      key: "cross-request-stage",
    });
    expect(response.status).toBe(422);
  });

  it("rejects a callback registered only to a different OAuth client", async () => {
    const response = await post(baseInput, { token: TOKENS.createB, key: "cross-client" });
    expect(response.status).toBe(403);
  });

  it("applies the SSRF policy at request time", async () => {
    const response = await post({
      ...baseInput,
      callback: { ...baseInput.callback, url: PRIVATE_CALLBACK },
    }, { token: TOKENS.createA, key: "private-callback" });
    expect(response.status).toBe(422);
  });

  it("requires the idempotency key and approval:create scope", async () => {
    const missingKey = await post(baseInput, { token: TOKENS.createA });
    expect(missingKey.status).toBe(400);
    const missingScope = await post(baseInput, { token: TOKENS.readOnly, key: "missing-scope" });
    expect(missingScope.status).toBe(403);
    const invalidToken = await post(baseInput, { token: "invalid-token", key: "invalid-token" });
    expect(invalidToken.status).toBe(401);
  });

  it("validates both the settled action contract and target", async () => {
    const invalidAction = await post({
      ...baseInput,
      action: { kind: "tool-call", toolName: "deploy", callId: "call", input: {}, audience: ids.clientA },
    }, { token: TOKENS.createA, key: "invalid-action" });
    expect(invalidAction.status).toBe(422);

    const invalidTarget = await post({ ...baseInput, suggestedApproverId: createId() }, {
      token: TOKENS.createA,
      key: "invalid-target",
    });
    expect(invalidTarget.status).toBe(403);
  });

  it("rolls back every creation side effect when notification queueing fails", async () => {
    await database().sql`
      create function test_fail_pending_job() returns trigger language plpgsql as $$
      begin
        raise exception 'forced pending notification failure';
      end
      $$
    `;
    await database().sql`
      create trigger test_fail_pending_job before insert on jobs
      for each row execute function test_fail_pending_job()
    `;
    const explanation = `Atomic rollback ${createId()}`;
    const artefactId = createId();
    await database().sql`
      insert into artefacts (
        id, workspace_id, agent_id, request_key, upload_ordinal, upload_payload_hash,
        expires_at, object_key, filename, media_type, size, sha256, state
      ) values (
        ${artefactId}, ${ids.workspace}, ${ids.agentA}, 'atomic-rollback', 0, ${"4".repeat(64)},
        now() + interval '1 hour', ${`${ids.workspace}/stage/rollback`}, 'plan.pdf', 'application/pdf', 8, ${"d".repeat(64)}, 'READY'
      )
    `;
    try {
      const response = await post({ ...baseInput, explanation, artefactIds: [artefactId] }, {
        token: TOKENS.createA,
        key: "atomic-rollback",
      });
      expect(response.status).toBe(500);
    } finally {
      await database().sql`drop trigger test_fail_pending_job on jobs`;
      await database().sql`drop function test_fail_pending_job()`;
    }

    const approvals = await database().sql`
      select id from approvals where workspace_id = ${ids.workspace} and explanation = ${explanation}
    `;
    const idempotency = await database().sql`
      select key from idempotency_keys
      where workspace_id = ${ids.workspace} and credential_id = ${ids.agentA}
        and operation = 'approval.request' and key = 'atomic-rollback'
    `;
    expect(approvals).toHaveLength(0);
    expect(idempotency).toHaveLength(0);
    const [staged] = await database().sql`select approval_id, state from artefacts where id = ${artefactId}`;
    expect(staged).toMatchObject({ approval_id: null, state: "READY" });
  });
});
