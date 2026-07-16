import { createId, ID_PATTERN, type InputRequest } from "@mayi/contracts";
import { createApp, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import requestInput from "../api/inputs/index.post";
import { tokenHash } from "./crypto";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;

const CALLBACK_A = "https://8.8.8.8/eve/v1/mayi/input-resolved";
const CALLBACK_B = "https://1.1.1.1/eve/v1/mayi/input-resolved";
const PRIVATE_CALLBACK = "https://127.0.0.1/eve/v1/mayi/input-resolved";
const TOKENS = {
  createA: `test-input-create-a-${createId()}`,
  createB: `test-input-create-b-${createId()}`,
  readOnly: `test-input-read-only-${createId()}`,
};

const ids = {
  workspace: createId(),
  user: createId(),
  clientA: createId(),
  clientB: createId(),
  agentA: createId(),
  agentB: createId(),
  readOnlyAgent: createId(),
  emailDestination: createId(),
  webhookDestination: createId(),
  webhookRule: createId(),
};

const baseInput: InputRequest = {
  type: "select",
  prompt: "Which environment should I deploy 1.2.3 to?",
  options: [
    { id: "staging", label: "Staging" },
    { id: "production", label: "Production", description: "Customer-facing", style: "danger" },
  ],
  allowFreeform: true,
  suggestedApproverId: ids.user,
  expiresInSeconds: 3_600,
  callback: {
    url: CALLBACK_A,
    state: "v1.opaque/adapter+ciphertext_ß_🔒",
  },
};

const app = createApp();
app.use("/api/inputs", requestInput);
const handle = toWebHandler(app);

function post(input: unknown, options: { token?: string; key?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.key) headers["idempotency-key"] = options.key;
  return handle(new Request("http://mayi.test/api/inputs", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  }));
}

describe.sequential("POST /api/inputs", () => {
  beforeAll(async () => {
    const sql = database().sql;
    await sql`
      insert into users (id, email, display_name, password_hash)
      values (${ids.user}, ${`input-request-${ids.user}@example.com`}, 'Input Request Owner', 'unused')
    `;
    await sql`insert into workspaces (id, name) values (${ids.workspace}, 'Input request integration')`;
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
      insert into forwarding_destinations (id, workspace_id, type, name, endpoint, mode, verified_at)
      values
        (${ids.emailDestination}, ${ids.workspace}, 'EMAIL', 'Approvers inbox', 'approvers@example.com', 'notify_only', now()),
        (${ids.webhookDestination}, ${ids.workspace}, 'WEBHOOK', 'Pending webhook', 'https://8.8.4.4/pending', 'notify_only', now())
    `;
    // The webhook rule matches everything; inputs must ignore it because rules gate
    // actions and webhook forwarding stays approval-only.
    await sql`
      insert into forwarding_rules (id, workspace_id, destination_id, action_kind)
      values (${ids.webhookRule}, ${ids.workspace}, ${ids.webhookDestination}, '*')
    `;
  });

  afterAll(async () => {
    const sql = database().sql;
    await sql`delete from workspaces where id = ${ids.workspace}`;
    await sql`delete from oauth_clients where id in (${ids.clientA}, ${ids.clientB})`;
    await sql`delete from users where id = ${ids.user}`;
    await database().close();
  });

  it("returns a complete PENDING select input and preserves opaque callback state", async () => {
    const response = await post(baseInput, { token: TOKENS.createA, key: "select-pending" });
    const input = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(input).toMatchObject({
      type: "select",
      prompt: baseInput.prompt,
      options: baseInput.options,
      allowFreeform: true,
      state: "PENDING",
      answer: null,
      attestation: null,
      respondentId: null,
      agentId: ids.agentA,
      answeredAt: null,
      cancelledAt: null,
    });
    expect(input.id).toMatch(ID_PATTERN);
    expect(input.createdAt).toEqual(expect.any(String));
    expect(input.expiresAt).toEqual(expect.any(String));
    expect(input).not.toHaveProperty("workspaceId");

    const inputId = String(input.id);
    const [callback] = await database().sql`
      select id, url, state, delivery_status from input_callbacks where input_id = ${inputId}
    `;
    expect(String(callback!.id)).toMatch(ID_PATTERN);
    expect(callback).toMatchObject({ url: CALLBACK_A, state: baseInput.callback!.state, delivery_status: "WAITING" });
    const eligible = await database().sql`
      select user_id from input_eligible_respondents where input_id = ${inputId}
    `;
    expect(eligible.map((row) => String(row.user_id))).toEqual([ids.user]);
    const queued = await database().sql`
      select type, payload from jobs where payload->>'inputId' = ${inputId} order by type
    `;
    expect(queued.map((row) => String(row.type))).toEqual([
      "email.input_pending",
      "push.input_pending",
    ]);
    expect(queued.find((row) => row.type === "push.input_pending")!.payload).toEqual({ inputId });
    expect(queued.find((row) => row.type === "email.input_pending")!.payload).toEqual({
      inputId,
      destinationId: ids.emailDestination,
    });
    const storedMetadata = await database().sql`
      select metadata from audit_events where subject_id = ${inputId}
      union all
      select response as metadata from idempotency_keys
      where operation = 'input.request' and response->>'id' = ${inputId}
    `;
    expect(JSON.stringify(storedMetadata)).not.toContain(baseInput.callback!.state);
    expect(JSON.stringify(queued)).not.toContain(baseInput.callback!.state);
    const [audited] = await database().sql`
      select actor_type, actor_id, event_type, subject_type from audit_events
      where subject_id = ${inputId} and event_type = 'input.requested'
    `;
    expect(audited).toMatchObject({ actor_type: "agent", actor_id: ids.agentA, subject_type: "input" });
  });

  it("creates a text input with no options and no freeform flag", async () => {
    const response = await post({
      type: "text",
      prompt: "What subject line should the launch email use?",
      expiresInSeconds: 900,
      callback: baseInput.callback,
    }, { token: TOKENS.createA, key: "text-pending" });
    const input = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(input).toMatchObject({ type: "text", options: null, allowFreeform: false, state: "PENDING" });
  });

  it("creates a confirmation input with exactly two options", async () => {
    const response = await post({
      type: "confirmation",
      prompt: "Proceed with the production deploy?",
      options: [
        { id: "proceed", label: "Proceed", style: "primary" },
        { id: "abort", label: "Abort", style: "danger" },
      ],
      expiresInSeconds: 900,
      callback: baseInput.callback,
    }, { token: TOKENS.createA, key: "confirmation-pending" });
    const input = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(input).toMatchObject({
      type: "confirmation",
      options: [
        { id: "proceed", label: "Proceed", style: "primary" },
        { id: "abort", label: "Abort", style: "danger" },
      ],
      allowFreeform: false,
      state: "PENDING",
    });
  });

  it("accepts a poller that omits the callback entirely", async () => {
    const withoutCallback = { ...baseInput };
    delete withoutCallback.callback;
    const response = await post(withoutCallback, { token: TOKENS.createA, key: "poller-no-callback" });
    const input = await response.json() as { id: string; state: string };
    expect(response.status).toBe(200);
    expect(input.state).toBe("PENDING");
    const callbacks = await database().sql`
      select id from input_callbacks where input_id = ${input.id}
    `;
    expect(callbacks).toHaveLength(0);
  });

  it.each([
    ["text with options", { type: "text", options: [{ id: "a", label: "A" }] }],
    ["text with allowFreeform", { type: "text", allowFreeform: true }],
    ["select without options", { type: "select" }],
    ["select with duplicate option ids", { type: "select", options: [{ id: "a", label: "A" }, { id: "a", label: "Again" }] }],
    ["confirmation with three options", {
      type: "confirmation",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
    }],
    ["confirmation with freeform", {
      type: "confirmation",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      allowFreeform: true,
    }],
  ] as const)("rejects the shape rule violation: %s", async (name, overrides) => {
    const response = await post({
      prompt: "Shape rules",
      expiresInSeconds: 900,
      callback: baseInput.callback,
      ...overrides,
    }, { token: TOKENS.createA, key: `shape-${name}` });
    expect(response.status).toBe(422);
  });

  it("returns the original input for identical reuse and rejects different content", async () => {
    const first = await post(baseInput, { token: TOKENS.createA, key: "stable-reuse" });
    const original = await first.json() as { id: string; state: string };
    const replay = await post(baseInput, { token: TOKENS.createA, key: "stable-reuse" });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(original);

    const randomizedStateReplay = await post({
      ...baseInput,
      callback: { ...baseInput.callback!, state: "different-randomized-ciphertext" },
    }, { token: TOKENS.createA, key: "stable-reuse" });
    expect(randomizedStateReplay.status).toBe(200);
    expect(await randomizedStateReplay.json()).toEqual(original);
    const [storedCallback] = await database().sql`
      select state from input_callbacks where input_id = ${original.id}
    `;
    expect(storedCallback!.state).toBe(baseInput.callback!.state);

    const changed = await post({ ...baseInput, prompt: "Different content." }, {
      token: TOKENS.createA,
      key: "stable-reuse",
    });
    expect(changed.status).toBe(409);
    const countRows = await database().sql`
      select count(*)::int as count from inputs where id = ${original.id}
    `;
    expect(Number(countRows[0]!.count)).toBe(1);
  });

  it("collapses concurrent identical requests to one input", async () => {
    const responses = await Promise.all(Array.from({ length: 4 }, () =>
      post(baseInput, { token: TOKENS.createA, key: "concurrent-reuse" })));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    const inputs = await Promise.all(responses.map((response) => response.json() as Promise<{ id: string }>));
    expect(new Set(inputs.map(({ id }) => id)).size).toBe(1);
    expect(inputs).toEqual(Array.from({ length: 4 }, () => inputs[0]));
  });

  it("rejects a callback registered only to a different OAuth client", async () => {
    const response = await post(baseInput, { token: TOKENS.createB, key: "cross-client" });
    expect(response.status).toBe(403);
  });

  it("applies the SSRF policy at request time", async () => {
    const response = await post({
      ...baseInput,
      callback: { ...baseInput.callback!, url: PRIVATE_CALLBACK },
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

  it("rejects a suggested respondent outside server policy", async () => {
    const response = await post({ ...baseInput, suggestedApproverId: createId() }, {
      token: TOKENS.createA,
      key: "invalid-target",
    });
    expect(response.status).toBe(403);
  });
});
