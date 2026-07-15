import { createId } from "@mayi/contracts";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import decision from "../api/approvals/[id]/decision.post";
import cancel from "../api/approvals/[id]/cancel.post";
import {
  CALLBACK_JOB_TYPE,
  CallbackDeliveryError,
  claimNextJob,
  markCallbackDelivered,
  markCallbackFailed,
  replayDeadLetterCallback,
} from "./callback-outbox";
import { tokenHash } from "./crypto";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;
process.env.SESSION_COOKIE_SECURE = "false";

const ids = {
  user: createId(), workspace: createId(), agent: createId(), client: createId(), session: createId(),
};
const sessionToken = `mayi_session_atomic_${createId()}`;
const agentToken = `atomic-agent-${createId()}`;
const state = "sealed.v1/Ω-literal\\bytes/🔒";

const decisionApp = createApp();
const decisionRouter = createRouter().post("/api/approvals/:id/decision", decision);
decisionApp.use(decisionRouter);
const handleDecision = toWebHandler(decisionApp);
const cancelApp = createApp();
const cancelRouter = createRouter().post("/api/approvals/:id/cancel", cancel);
cancelApp.use(cancelRouter);
const handleCancel = toWebHandler(cancelApp);

async function createPending(expired = false): Promise<{ approvalId: string; callbackId: string }> {
  const approvalId = createId();
  const callbackId = createId();
  await database().sql`
    insert into approvals (
      id, workspace_id, agent_id, state, action, explanation, enforcement,
      action_digest, manifest_digest, policy_version, expires_at, sealed_at
    ) values (
      ${approvalId}, ${ids.workspace}, ${ids.agent}, 'PENDING',
      ${JSON.stringify({ kind: "tool-call", toolName: "deploy", callId: createId(), input: {} })}::jsonb,
      'Atomic terminal transition', 'cooperative', ${"a".repeat(64)}, ${"b".repeat(64)}, 1,
      ${new Date(expired ? Date.now() - 60_000 : Date.now() + 600_000).toISOString()}, now()
    )
  `;
  await database().sql`
    insert into approval_callbacks (id, approval_id, workspace_id, url, state)
    values (${callbackId}, ${approvalId}, ${ids.workspace}, 'https://8.8.8.8/callback', ${state})
  `;
  await database().sql`
    insert into eligible_approvers (approval_id, workspace_id, user_id)
    values (${approvalId}, ${ids.workspace}, ${ids.user})
  `;
  return { approvalId, callbackId };
}

function decide(approvalId: string, value: "APPROVED" | "DENIED"): Promise<Response> {
  return handleDecision(new Request(`http://mayi.test/api/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
      "x-workspace-id": ids.workspace,
    },
    body: JSON.stringify({ decision: value }),
  }));
}

function cancelApproval(approvalId: string): Promise<Response> {
  return handleCancel(new Request(`http://mayi.test/api/approvals/${approvalId}/cancel`, {
    method: "POST", headers: { authorization: `Bearer ${agentToken}` },
  }));
}

async function failCallbackJobInserts(): Promise<void> {
  await database().sql`
    create or replace function test_fail_callback_job() returns trigger language plpgsql as $$
    begin
      if new.type = 'callback.approval_resolved' then
        raise exception 'forced callback outbox failure';
      end if;
      return new;
    end
    $$
  `;
  await database().sql`
    create trigger test_fail_callback_job before insert on jobs
    for each row execute function test_fail_callback_job()
  `;
}

async function allowCallbackJobInserts(): Promise<void> {
  await database().sql`drop trigger if exists test_fail_callback_job on jobs`;
  await database().sql`drop function if exists test_fail_callback_job()`;
}

beforeAll(async () => {
  await database().sql`
    insert into users (id, email, display_name, password_hash)
    values (${ids.user}, ${`callback-outbox-${ids.user}@example.com`}, 'Callback Approver', 'unused')
  `;
  await database().sql`insert into workspaces (id, name) values (${ids.workspace}, 'Callback outbox integration')`;
  await database().sql`insert into memberships (workspace_id, user_id, role) values (${ids.workspace}, ${ids.user}, 'OWNER')`;
  await database().sql`
    insert into oauth_clients (id, name, redirect_uris, approval_callback_uris, registration_ip_hash)
    values (${ids.client}, 'Callback client', ${["https://client.example/cb"]}, ${["https://8.8.8.8/callback"]}, ${"c".repeat(64)})
  `;
  await database().sql`
    insert into agents (id, workspace_id, name, client_id, scopes, credential_hash, created_by)
    values (${ids.agent}, ${ids.workspace}, 'Callback agent', ${ids.client}, ${["approval:cancel"]}, ${await tokenHash(agentToken)}, ${ids.user})
  `;
  await database().sql`
    insert into sessions (id, user_id, token_hash, recent_auth_at, expires_at)
    values (${ids.session}, ${ids.user}, ${await tokenHash(sessionToken)}, now(), now() + interval '1 hour')
  `;
});

afterAll(async () => {
  await allowCallbackJobInserts();
  await database().sql`delete from workspaces where id = ${ids.workspace}`;
  await database().sql`delete from oauth_clients where id = ${ids.client}`;
  await database().sql`delete from users where id = ${ids.user}`;
  await database().close();
});

describe.sequential("terminal callback outbox transactions", () => {
  it.each([
    ["APPROVED", false],
    ["DENIED", false],
    ["EXPIRED", true],
    ["CANCELLED", false],
  ] as const)("rolls back %s and every side effect when callback queueing fails", async (terminal, expired) => {
    const { approvalId, callbackId } = await createPending(expired);
    await failCallbackJobInserts();
    try {
      const response = terminal === "CANCELLED"
        ? await cancelApproval(approvalId)
        : await decide(approvalId, terminal === "DENIED" ? "DENIED" : "APPROVED");
      expect(response.status).toBe(500);
    } finally {
      await allowCallbackJobInserts();
    }
    const [approval] = await database().sql`select state, decided_at from approvals where id = ${approvalId}`;
    const [callback] = await database().sql`select delivery_status, occurred_at from approval_callbacks where id = ${callbackId}`;
    const jobs = await database().sql`select id from jobs where type = ${CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId}`;
    const receipts = await database().sql`select id from receipts where approval_id = ${approvalId}`;
    expect(approval).toMatchObject({ state: "PENDING", decided_at: null });
    expect(callback).toMatchObject({ delivery_status: "WAITING", occurred_at: null });
    expect(jobs).toHaveLength(0);
    expect(receipts).toHaveLength(0);
  });

  it.each([
    ["APPROVED", false],
    ["DENIED", false],
    ["EXPIRED", true],
    ["CANCELLED", false],
  ] as const)("commits %s with exactly one callback job", async (terminal, expired) => {
    const { approvalId, callbackId } = await createPending(expired);
    const response = terminal === "CANCELLED"
      ? await cancelApproval(approvalId)
      : await decide(approvalId, terminal === "DENIED" ? "DENIED" : "APPROVED");
    expect(response.status).toBe(200);
    const [approval] = await database().sql`select state from approvals where id = ${approvalId}`;
    const [callback] = await database().sql`select delivery_status, occurred_at, state from approval_callbacks where id = ${callbackId}`;
    const jobs = await database().sql`
      select payload from jobs where type = ${CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId}
    `;
    expect(approval!.state).toBe(terminal);
    expect(callback).toMatchObject({ delivery_status: "READY", state });
    expect(callback!.occurred_at).not.toBeNull();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ callbackId });
    expect(JSON.stringify(jobs)).not.toContain(state);
    const receipts = await database().sql`select compact_jws from receipts where approval_id = ${approvalId}`;
    expect(receipts).toHaveLength(terminal === "APPROVED" ? 1 : 0);
  });

  it("reclaims a stale RUNNING lease after a simulated worker crash", async () => {
    const { approvalId, callbackId } = await createPending();
    expect((await decide(approvalId, "DENIED")).status).toBe(200);
    const [queued] = await database().sql`select id from jobs where type = ${CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId}`;
    const first = await claimNextJob(database().sql, { jobId: String(queued!.id) });
    expect(first).toMatchObject({ type: CALLBACK_JOB_TYPE, payload: { callbackId }, attempts: 1 });
    await database().sql`update jobs set locked_at = now() - interval '6 minutes' where id = ${first!.id}`;
    await database().sql`update approval_callbacks set lease_expires_at = now() - interval '1 minute' where id = ${callbackId}`;
    const reclaimed = await claimNextJob(database().sql, { jobId: first!.id });
    expect(reclaimed).toMatchObject({ id: first!.id, attempts: 2 });
  });

  it("fences late success and failure from a reclaimed lease", async () => {
    const { approvalId, callbackId } = await createPending();
    expect((await decide(approvalId, "DENIED")).status).toBe(200);
    const [queued] = await database().sql`select id from jobs where type = ${CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId}`;
    const first = await claimNextJob(database().sql, { jobId: String(queued!.id) });
    await database().sql`update jobs set locked_at = now() - interval '6 minutes' where id = ${first!.id}`;
    await database().sql`update approval_callbacks set lease_expires_at = now() - interval '1 minute' where id = ${callbackId}`;
    const second = await claimNextJob(database().sql, { jobId: first!.id });
    expect(second).toMatchObject({ attempts: 2 });
    expect(second!.lease_token).not.toBe(first!.lease_token);

    await expect(markCallbackDelivered(first!)).resolves.toBe(false);
    await expect(markCallbackFailed(first!, new CallbackDeliveryError("http_503", true))).resolves.toBe("stale");
    const [runningJob] = await database().sql`select state, attempts, lease_token from jobs where id = ${first!.id}`;
    const [runningCallback] = await database().sql`select delivery_status, attempts from approval_callbacks where id = ${callbackId}`;
    expect(runningJob).toMatchObject({ state: "RUNNING", attempts: 2, lease_token: second!.lease_token });
    expect(runningCallback).toMatchObject({ delivery_status: "RUNNING", attempts: 2 });

    await expect(markCallbackDelivered(second!)).resolves.toBe(true);
    const [deliveredJob] = await database().sql`select state, lease_token from jobs where id = ${first!.id}`;
    const [deliveredCallback] = await database().sql`select delivery_status from approval_callbacks where id = ${callbackId}`;
    expect(deliveredJob).toMatchObject({ state: "SUCCEEDED", lease_token: null });
    expect(deliveredCallback!.delivery_status).toBe("DELIVERED");
  });

  it("fences an old same-attempt worker after dead-letter replay", async () => {
    const { approvalId, callbackId } = await createPending();
    expect((await decide(approvalId, "DENIED")).status).toBe(200);
    const [queued] = await database().sql`select id from jobs where type = ${CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId}`;
    const old = await claimNextJob(database().sql, { jobId: String(queued!.id) });
    await expect(markCallbackFailed(old!, new CallbackDeliveryError("http_400", false))).resolves.toBe("dead_letter");
    await replayDeadLetterCallback(callbackId);
    const replayed = await claimNextJob(database().sql, { jobId: old!.id });
    expect(replayed).toMatchObject({ attempts: 1 });
    expect(replayed!.lease_token).not.toBe(old!.lease_token);

    await expect(markCallbackDelivered(old!)).resolves.toBe(false);
    await expect(markCallbackFailed(old!, new CallbackDeliveryError("http_503", true))).resolves.toBe("stale");
    const [job] = await database().sql`select state, attempts, lease_token from jobs where id = ${old!.id}`;
    expect(job).toMatchObject({ state: "RUNNING", attempts: 1, lease_token: replayed!.lease_token });
    await expect(markCallbackDelivered(replayed!)).resolves.toBe(true);
  });

  it("dead-letters exhausted delivery and manual replay keeps the stable event ID", async () => {
    const { approvalId, callbackId } = await createPending();
    expect((await decide(approvalId, "DENIED")).status).toBe(200);
    const [row] = await database().sql`
      update jobs set attempts = 9 where type = ${CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId} returning id
    `;
    const job = await claimNextJob(database().sql, { jobId: String(row!.id) });
    expect(job).toMatchObject({ id: row!.id, attempts: 10, payload: { callbackId } });
    expect(await markCallbackFailed(job!, new CallbackDeliveryError("http_503", true))).toBe("dead_letter");
    const [dead] = await database().sql`select delivery_status from approval_callbacks where id = ${callbackId}`;
    expect(dead!.delivery_status).toBe("DEAD_LETTER");
    await expect(replayDeadLetterCallback(callbackId)).resolves.toEqual({ id: callbackId, status: "READY" });
    const [replayed] = await database().sql`select delivery_status, attempts from approval_callbacks where id = ${callbackId}`;
    const [replayedJob] = await database().sql`select state, attempts, dedupe_key from jobs where id = ${row!.id}`;
    expect(replayed).toMatchObject({ delivery_status: "READY", attempts: 0 });
    expect(replayedJob).toMatchObject({ state: "READY", attempts: 0, dedupe_key: callbackId });
  });
});
