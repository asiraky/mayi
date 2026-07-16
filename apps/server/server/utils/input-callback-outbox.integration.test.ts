import { InputResolvedEvent, canonicalize, createId } from "@mayi/contracts";
import { createApp, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import drain from "../api/internal/jobs/drain.post";
import {
  INPUT_CALLBACK_JOB_TYPE,
  activateInputCallback,
  claimNextJob,
  markCallbackDelivered,
  replayDeadLetterCallback,
  sendInputCallback,
  type OutboxJob,
} from "./callback-outbox";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;
const CRON_SECRET = `input-outbox-cron-${createId()}`;
process.env.CRON_SECRET = CRON_SECRET;

const ids = { user: createId(), workspace: createId(), agent: createId() };
const ownerEmail = `input-outbox-${ids.user}@example.com`;
const opaqueState = "sealed.v1/Ω+ciphertext_ß_🔒";
const answerValue = { optionId: "production" };
const attestationValue = `attestation-jws-${createId()}`;

const drainApp = createApp();
drainApp.use("/api/internal/jobs/drain", drain);
const handleDrain = toWebHandler(drainApp);

async function createResolvedInput(
  terminal: "ANSWERED" | "CANCELLED",
  url = "https://callback.example/resolve",
): Promise<{ inputId: string; callbackId: string; jobId: string }> {
  const inputId = createId();
  const callbackId = createId();
  await database().sql.begin(async (sql) => {
    await sql`
      insert into inputs (
        id, workspace_id, agent_id, type, prompt, options, allow_freeform, state,
        answer, attestation, respondent_id, expires_at, answered_at, cancelled_at
      ) values (
        ${inputId}, ${ids.workspace}, ${ids.agent}, 'select', 'Which environment?',
        ${JSON.stringify([{ id: "staging", label: "Staging" }, { id: "production", label: "Production" }])}::jsonb,
        false, ${terminal},
        ${terminal === "ANSWERED" ? JSON.stringify(answerValue) : null}::jsonb,
        ${terminal === "ANSWERED" ? attestationValue : null},
        ${terminal === "ANSWERED" ? ids.user : null},
        now() + interval '1 hour',
        ${terminal === "ANSWERED" ? new Date().toISOString() : null},
        ${terminal === "CANCELLED" ? new Date().toISOString() : null}
      )
    `;
    await sql`
      insert into input_callbacks (id, input_id, workspace_id, url, state)
      values (${callbackId}, ${inputId}, ${ids.workspace}, ${url}, ${opaqueState})
    `;
    await activateInputCallback(sql, inputId);
  });
  const [job] = await database().sql`
    select id from jobs where type = ${INPUT_CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId}
  `;
  return { inputId, callbackId, jobId: String(job!.id) };
}

async function claim(jobId: string): Promise<OutboxJob> {
  const job = await claimNextJob(database().sql, { jobId });
  if (!job) throw new Error("Expected input callback job to be claimable");
  return job;
}

beforeAll(async () => {
  // Crashed earlier runs can leave claimable jobs behind; the drain test below
  // processes every claimable job, so start from a clean outbox.
  await database().sql`delete from jobs where state in ('READY', 'FAILED', 'RUNNING')`;
  await database().sql`
    insert into users (id, email, display_name, password_hash)
    values (${ids.user}, ${ownerEmail}, 'Input Outbox Owner', 'unused')
  `;
  await database().sql`insert into workspaces (id, name) values (${ids.workspace}, 'Input callback outbox integration')`;
  await database().sql`insert into memberships (workspace_id, user_id, role) values (${ids.workspace}, ${ids.user}, 'OWNER')`;
  await database().sql`
    insert into agents (id, workspace_id, name, scopes, credential_hash, created_by)
    values (${ids.agent}, ${ids.workspace}, 'Outbox agent', ${["approval:create"]}, 'unused-hash', ${ids.user})
  `;
});

afterAll(async () => {
  await database().sql`delete from workspaces where id = ${ids.workspace}`;
  await database().sql`delete from users where id = ${ids.user}`;
  await database().close();
});

describe.sequential("input.resolved callback outbox", () => {
  it("delivers an answered event embedding respondent, answer and attestation", async () => {
    const { inputId, callbackId, jobId } = await createResolvedInput("ANSWERED");
    const job = await claim(jobId);
    const bodies: string[] = [];
    const { event, body, status } = await sendInputCallback(job, {
      resolve: async () => ["8.8.8.8"],
      transport: async (_target, requestBody) => { bodies.push(requestBody); return { status: 200, bytes: 0 }; },
    });
    expect(status).toBe(200);
    expect(event).toEqual({
      id: callbackId,
      type: "input.resolved",
      version: 1,
      inputId,
      status: "answered",
      state: opaqueState,
      occurredAt: expect.any(String),
      respondent: { id: ids.user, email: ownerEmail },
      answer: answerValue,
      attestation: attestationValue,
    });
    expect(bodies).toEqual([body]);
    expect(body).toBe(canonicalize(event));
    expect(InputResolvedEvent.parse(JSON.parse(body))).toEqual(event);
    await expect(markCallbackDelivered(job)).resolves.toBe(true);
    const [callback] = await database().sql`select delivery_status from input_callbacks where id = ${callbackId}`;
    expect(callback!.delivery_status).toBe("DELIVERED");
  });

  it("delivers a cancelled event with no respondent, answer or attestation", async () => {
    const { inputId, callbackId, jobId } = await createResolvedInput("CANCELLED");
    const job = await claim(jobId);
    const { event } = await sendInputCallback(job, {
      resolve: async () => ["8.8.8.8"],
      transport: async () => ({ status: 204, bytes: 0 }),
    });
    expect(event).toEqual({
      id: callbackId,
      type: "input.resolved",
      version: 1,
      inputId,
      status: "cancelled",
      state: opaqueState,
      occurredAt: expect.any(String),
    });
    expect(event).not.toHaveProperty("answer");
    expect(event).not.toHaveProperty("respondent");
    expect(event).not.toHaveProperty("attestation");
    await expect(markCallbackDelivered(job)).resolves.toBe(true);
  });

  it("expires overdue inputs from the drain sweep and enqueues their expired events", async () => {
    const inputId = createId();
    const callbackId = createId();
    // A private callback URL fails SSRF validation without touching the network,
    // deterministically exercising the dead-letter path for the new job type.
    await database().sql`
      insert into inputs (id, workspace_id, agent_id, type, prompt, state, expires_at)
      values (${inputId}, ${ids.workspace}, ${ids.agent}, 'text', 'Too late to ask', 'PENDING', now() - interval '1 minute')
    `;
    await database().sql`
      insert into input_callbacks (id, input_id, workspace_id, url, state)
      values (${callbackId}, ${inputId}, ${ids.workspace}, 'https://127.0.0.1/eve/callback', ${opaqueState})
    `;

    const response = await handleDrain(new Request("http://mayi.test/api/internal/jobs/drain", {
      method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` },
    }));
    const summary = await response.json() as { expiredInputs: number; processed: number };
    expect(response.status).toBe(200);
    expect(summary.expiredInputs).toBeGreaterThanOrEqual(1);

    const [input] = await database().sql`select state from inputs where id = ${inputId}`;
    expect(input!.state).toBe("EXPIRED");
    const [audited] = await database().sql`
      select actor_type from audit_events where subject_id = ${inputId} and event_type = 'input.expired'
    `;
    expect(audited).toMatchObject({ actor_type: "system" });

    // The stable expired event was enqueued, then dead-lettered by URL policy.
    const [job] = await database().sql`
      select state, last_error from jobs where type = ${INPUT_CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId}
    `;
    expect(job).toMatchObject({ state: "DEAD_LETTER" });
    expect(String(job!.last_error)).toMatch(/^url_/);
    const [callback] = await database().sql`
      select delivery_status, occurred_at from input_callbacks where id = ${callbackId}
    `;
    expect(callback!.delivery_status).toBe("DEAD_LETTER");
    expect(callback!.occurred_at).not.toBeNull();

    // Operator replay reuses the approval machinery for input callbacks.
    await expect(replayDeadLetterCallback(callbackId)).resolves.toEqual({ id: callbackId, status: "READY" });
    const [replayed] = await database().sql`
      select delivery_status, attempts from input_callbacks where id = ${callbackId}
    `;
    expect(replayed).toMatchObject({ delivery_status: "READY", attempts: 0 });
    const [replayedJob] = await database().sql`
      select state, attempts from jobs where type = ${INPUT_CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId}
    `;
    expect(replayedJob).toMatchObject({ state: "READY", attempts: 0 });
    // Leave nothing claimable behind for later suites.
    await database().sql`delete from jobs where type = ${INPUT_CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId}`;
  });
});
