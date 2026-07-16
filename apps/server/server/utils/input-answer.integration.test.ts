import { canonicalDigest, createId, type InputAnswer, type InputOption, type InputType } from "@mayi/contracts";
import { verifyAnswerAttestation } from "@mayi/receipts";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import answer from "../api/inputs/[id]/answer.post";
import cancel from "../api/inputs/[id]/cancel.post";
import { INPUT_CALLBACK_JOB_TYPE } from "./callback-outbox";
import { getConfig } from "./config";
import { tokenHash } from "./crypto";
import { database } from "./runtime";
import { signingKeys } from "./signer";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;
process.env.SESSION_COOKIE_SECURE = "false";

const ids = {
  owner: createId(), member: createId(), workspace: createId(), agent: createId(),
  ownerSession: createId(), memberSession: createId(),
};
const ownerSessionToken = `mayi_session_input_owner_${createId()}`;
const memberSessionToken = `mayi_session_input_member_${createId()}`;
const agentToken = `input-answer-agent-${createId()}`;
const opaqueState = "sealed.v1/Ω-literal\\bytes/🔒";
const PROMPT = "Which environment should I deploy 1.2.3 to?";
const OPTIONS: InputOption[] = [
  { id: "staging", label: "Staging" },
  { id: "production", label: "Production", style: "danger" },
];

const app = createApp();
const router = createRouter()
  .post("/api/inputs/:id/answer", answer)
  .post("/api/inputs/:id/cancel", cancel);
app.use(router);
const handle = toWebHandler(app);

async function createInput(overrides: {
  type?: InputType | undefined;
  options?: readonly InputOption[] | null | undefined;
  allowFreeform?: boolean | undefined;
  expired?: boolean | undefined;
} = {}): Promise<{ inputId: string; callbackId: string }> {
  const inputId = createId();
  const callbackId = createId();
  const type = overrides.type ?? "select";
  const options = overrides.options === undefined
    ? (type === "text" ? null : OPTIONS)
    : overrides.options;
  await database().sql`
    insert into inputs (
      id, workspace_id, agent_id, type, prompt, options, allow_freeform, state, expires_at
    ) values (
      ${inputId}, ${ids.workspace}, ${ids.agent}, ${type}, ${PROMPT},
      ${options ? JSON.stringify(options) : null}::jsonb, ${overrides.allowFreeform ?? false}, 'PENDING',
      ${new Date(overrides.expired ? Date.now() - 60_000 : Date.now() + 600_000).toISOString()}
    )
  `;
  await database().sql`
    insert into input_callbacks (id, input_id, workspace_id, url, state)
    values (${callbackId}, ${inputId}, ${ids.workspace}, 'https://8.8.8.8/callback', ${opaqueState})
  `;
  await database().sql`
    insert into input_eligible_respondents (input_id, workspace_id, user_id)
    values (${inputId}, ${ids.workspace}, ${ids.owner})
  `;
  return { inputId, callbackId };
}

function respond(inputId: string, body: unknown, sessionToken = ownerSessionToken): Promise<Response> {
  return handle(new Request(`http://mayi.test/api/inputs/${inputId}/answer`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
      "x-workspace-id": ids.workspace,
    },
    body: JSON.stringify(body),
  }));
}

function cancelInput(inputId: string): Promise<Response> {
  return handle(new Request(`http://mayi.test/api/inputs/${inputId}/cancel`, {
    method: "POST", headers: { authorization: `Bearer ${agentToken}` },
  }));
}

describe.sequential("POST /api/inputs/:id/answer", () => {
  beforeAll(async () => {
    const sql = database().sql;
    await sql`
      insert into users (id, email, display_name, password_hash)
      values
        (${ids.owner}, ${`input-answer-owner-${ids.owner}@example.com`}, 'Input Owner', 'unused'),
        (${ids.member}, ${`input-answer-member-${ids.member}@example.com`}, 'Input Member', 'unused')
    `;
    await sql`insert into workspaces (id, name) values (${ids.workspace}, 'Input answer integration')`;
    await sql`
      insert into memberships (workspace_id, user_id, role)
      values (${ids.workspace}, ${ids.owner}, 'OWNER'), (${ids.workspace}, ${ids.member}, 'MEMBER')
    `;
    await sql`
      insert into agents (id, workspace_id, name, scopes, credential_hash, created_by)
      values (${ids.agent}, ${ids.workspace}, 'Asking agent', ${["approval:create", "approval:cancel"]}, ${await tokenHash(agentToken)}, ${ids.owner})
    `;
    await sql`
      insert into sessions (id, user_id, token_hash, recent_auth_at, expires_at)
      values
        (${ids.ownerSession}, ${ids.owner}, ${await tokenHash(ownerSessionToken)}, now(), now() + interval '1 hour'),
        (${ids.memberSession}, ${ids.member}, ${await tokenHash(memberSessionToken)}, now(), now() + interval '1 hour')
    `;
  });

  afterAll(async () => {
    await database().sql`delete from workspaces where id = ${ids.workspace}`;
    await database().sql`delete from users where id in (${ids.owner}, ${ids.member})`;
    await database().close();
  });

  it("answers a select input and mints a verifiable attestation", async () => {
    const { inputId, callbackId } = await createInput();
    const response = await respond(inputId, { optionId: "production" });
    const input = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(input).toMatchObject({
      id: inputId,
      state: "ANSWERED",
      answer: { optionId: "production" },
      respondentId: ids.owner,
      cancelledAt: null,
    });
    expect(input.answeredAt).toEqual(expect.any(String));
    expect(input.attestation).toEqual(expect.any(String));

    const keys = await signingKeys();
    const claims = await verifyAnswerAttestation(String(input.attestation), keys.publicJwks, {
      issuer: getConfig().receiptIssuer,
    });
    expect(claims).toMatchObject({
      iss: getConfig().receiptIssuer,
      sub: inputId,
      workspace_id: ids.workspace,
      agent_id: ids.agent,
      input_type: "select",
      answer: { optionId: "production" },
      respondent_id: ids.owner,
      answered_at: input.answeredAt,
    });
    expect(claims.jti).toMatch(/^[a-z0-9]+$/i);
    expect(claims.prompt_digest).toBe(await canonicalDigest({ prompt: PROMPT }));
    expect(claims.answer_digest).toBe(await canonicalDigest({ optionId: "production" }));

    const [callback] = await database().sql`
      select delivery_status, occurred_at, state from input_callbacks where id = ${callbackId}
    `;
    expect(callback).toMatchObject({ delivery_status: "READY", state: opaqueState });
    expect(callback!.occurred_at).not.toBeNull();
    const jobs = await database().sql`
      select payload from jobs where type = ${INPUT_CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId}
    `;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ callbackId });
    expect(JSON.stringify(jobs)).not.toContain(opaqueState);

    const [audited] = await database().sql`
      select actor_type, actor_id, subject_type from audit_events
      where subject_id = ${inputId} and event_type = 'input.answered'
    `;
    expect(audited).toMatchObject({ actor_type: "user", actor_id: ids.owner, subject_type: "input" });
  });

  it.each([
    ["text", { type: "text" as const, options: null }, { text: "Use the bold subject line." }],
    ["freeform select", { type: "select" as const, allowFreeform: true }, { text: "Neither — deploy to the canary ring." }],
    ["confirmation", {
      type: "confirmation" as const,
      options: [{ id: "proceed", label: "Proceed" }, { id: "abort", label: "Abort" }],
    }, { optionId: "proceed" }],
  ] as const)("answers a %s input", async (_name, overrides, body) => {
    const { inputId } = await createInput(overrides);
    const response = await respond(inputId, body);
    const input = await response.json() as { state: string; answer: InputAnswer };
    expect(response.status).toBe(200);
    expect(input.state).toBe("ANSWERED");
    expect(input.answer).toEqual(body);
  });

  it.each([
    ["an optionId outside the offered options", {}, { optionId: "self-hosted" }],
    ["text on a strict select", {}, { text: "Somewhere else" }],
    ["an optionId on a text input", { type: "text" as const, options: null }, { optionId: "staging" }],
    ["text on a confirmation", {
      type: "confirmation" as const,
      options: [{ id: "proceed", label: "Proceed" }, { id: "abort", label: "Abort" }],
    }, { text: "Proceed I guess" }],
  ] as const)("rejects %s with 422 and stays pending", async (_name, overrides, body) => {
    const { inputId, callbackId } = await createInput(overrides);
    const response = await respond(inputId, body);
    expect(response.status).toBe(422);
    const [input] = await database().sql`select state, answer, attestation from inputs where id = ${inputId}`;
    expect(input).toMatchObject({ state: "PENDING", answer: null, attestation: null });
    const [callback] = await database().sql`select delivery_status from input_callbacks where id = ${callbackId}`;
    expect(callback!.delivery_status).toBe("WAITING");
  });

  it("refuses a workspace member who is not an eligible respondent", async () => {
    const { inputId } = await createInput();
    const response = await respond(inputId, { optionId: "staging" }, memberSessionToken);
    expect(response.status).toBe(403);
    const [input] = await database().sql`select state from inputs where id = ${inputId}`;
    expect(input!.state).toBe("PENDING");
  });

  it("flips an overdue input to EXPIRED and activates its callback instead of answering", async () => {
    const { inputId, callbackId } = await createInput({ expired: true });
    const response = await respond(inputId, { optionId: "staging" });
    const input = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(input).toMatchObject({ state: "EXPIRED", answer: null, attestation: null, respondentId: null });
    const [callback] = await database().sql`
      select delivery_status, occurred_at from input_callbacks where id = ${callbackId}
    `;
    expect(callback!.delivery_status).toBe("READY");
    expect(callback!.occurred_at).not.toBeNull();
    const jobs = await database().sql`
      select id from jobs where type = ${INPUT_CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId}
    `;
    expect(jobs).toHaveLength(1);
    const [audited] = await database().sql`
      select actor_type from audit_events where subject_id = ${inputId} and event_type = 'input.expired'
    `;
    expect(audited).toMatchObject({ actor_type: "system" });
  });

  it("rejects a second answer once the input is terminal", async () => {
    const { inputId } = await createInput();
    expect((await respond(inputId, { optionId: "staging" })).status).toBe(200);
    const again = await respond(inputId, { optionId: "production" });
    expect(again.status).toBe(409);
    const [input] = await database().sql`select answer from inputs where id = ${inputId}`;
    expect(input!.answer).toEqual({ optionId: "staging" });
  });

  it("returns 404 for an input outside the workspace", async () => {
    const response = await respond(createId(), { optionId: "staging" });
    expect(response.status).toBe(404);
  });

  it("cancels a pending input through the agent and refuses to answer it afterwards", async () => {
    const { inputId, callbackId } = await createInput();
    const cancelled = await cancelInput(inputId);
    const input = await cancelled.json() as Record<string, unknown>;
    expect(cancelled.status).toBe(200);
    expect(input).toMatchObject({ state: "CANCELLED" });
    expect(input.cancelledAt).toEqual(expect.any(String));
    const [callback] = await database().sql`
      select delivery_status from input_callbacks where id = ${callbackId}
    `;
    expect(callback!.delivery_status).toBe("READY");
    const answerAfter = await respond(inputId, { optionId: "staging" });
    expect(answerAfter.status).toBe(409);
    expect((await cancelInput(inputId)).status).toBe(409);
    const [audited] = await database().sql`
      select actor_type, actor_id from audit_events where subject_id = ${inputId} and event_type = 'input.cancelled'
    `;
    expect(audited).toMatchObject({ actor_type: "agent", actor_id: ids.agent });
  });
});
