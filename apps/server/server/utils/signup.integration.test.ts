import { readFile } from "node:fs/promises";
import { createId, type Action } from "@mayi/contracts";
import { createApp, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import signup from "../api/auth/signup.post";
import { queuePendingNotifications } from "./pending-notifications";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;
delete process.env.BOOTSTRAP_SECRET;

vi.mock("./auth-rate-limit", () => ({
  authenticationClientAddress: () => "signup-integration-test",
  recordAuthenticationAttempt: async () => "unthrottled",
}));

const BACKFILL_MIGRATION = new URL(
  "../../../../packages/db/drizzle/0010_default_email_channel.sql",
  import.meta.url,
);

const app = createApp();
app.use("/api/auth/signup", signup);
const handle = toWebHandler(app);

function post(input: unknown): Promise<Response> {
  return handle(new Request("http://mayi.test/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

async function defaultChannel(workspaceId: string) {
  const destinations = await database().sql`
    select id, type, name, endpoint, mode, mapped_user_id, verified_at, active
    from forwarding_destinations where workspace_id = ${workspaceId}
  `;
  const rules = await database().sql`
    select destination_id, action_kind, active
    from forwarding_rules where workspace_id = ${workspaceId}
  `;
  return { destinations, rules };
}

describe.sequential("signup default notification channel", () => {
  const email = `owner-${createId()}@Example.COM`;
  let workspaceId: string;
  let userId: string;
  let destinationId: string;

  afterAll(async () => {
    await database().close();
  });

  beforeAll(async () => {
    const response = await post({ email, password: "correct-horse-battery-9!", displayName: "Owner" });
    expect(response.status).toBe(200);
    const body = await response.json() as { user: { id: string }; workspace: { id: string } };
    workspaceId = body.workspace.id;
    userId = body.user.id;
  });

  it("creates a born-verified EMAIL destination for the account address", async () => {
    const { destinations } = await defaultChannel(workspaceId);
    expect(destinations).toHaveLength(1);
    expect(destinations[0]).toMatchObject({
      type: "EMAIL",
      name: "Account email",
      endpoint: email.toLowerCase(),
      mode: "notify_only",
      mapped_user_id: userId,
      active: true,
    });
    expect(destinations[0]!.verified_at).not.toBeNull();
    destinationId = String(destinations[0]!.id);
  });

  it("creates an active catch-all forwarding rule", async () => {
    const { rules } = await defaultChannel(workspaceId);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ destination_id: destinationId, action_kind: "*", active: true });
  });

  it("queues an email.approval_pending job for a fresh account's first approval", async () => {
    const sql = database().sql;
    const agentId = createId();
    const approvalId = createId();
    const action: Action = { kind: "tool-call", toolName: "send_invoice", callId: "call-1", input: {} };
    await sql`insert into agents (id, workspace_id, name, scopes, created_by) values (${agentId}, ${workspaceId}, 'Test agent', ${["approval:create"]}, ${userId})`;
    await sql`
      insert into approvals (id, workspace_id, agent_id, state, action, explanation, action_digest, manifest_digest, sealed_at, expires_at)
      values (${approvalId}, ${workspaceId}, ${agentId}, 'PENDING', ${JSON.stringify(action)}::jsonb, 'Send the invoice.', 'digest', 'digest', now(), now() + interval '1 hour')
    `;

    await queuePendingNotifications(sql, { workspaceId, approvalId, action });

    const jobs = await sql`select type, dedupe_key from jobs where workspace_id = ${workspaceId}`;
    expect(jobs.map((job) => job.type)).toEqual(expect.arrayContaining(["push.approval_pending", "email.approval_pending"]));
    expect(jobs.find((job) => job.type === "email.approval_pending")).toMatchObject({
      dedupe_key: `${approvalId}:${destinationId}`,
    });
    const deliveries = await sql`select destination_id from forwarding_deliveries where approval_id = ${approvalId}`;
    expect(deliveries).toHaveLength(1);
    expect(String(deliveries[0]!.destination_id)).toBe(destinationId);
  });

  it("backfills existing owners exactly once and skips configured workspaces", async () => {
    const sql = database().sql;
    const migration = await readFile(BACKFILL_MIGRATION, "utf8");
    const legacy = {
      userId: createId(),
      workspaceId: createId(),
      email: `legacy-${createId()}@Example.COM`,
    };
    await sql`insert into users (id, email, display_name, password_hash) values (${legacy.userId}, ${legacy.email}, 'Legacy owner', 'x')`;
    await sql`insert into workspaces (id, name) values (${legacy.workspaceId}, 'Legacy workspace')`;
    await sql`insert into memberships (workspace_id, user_id, role) values (${legacy.workspaceId}, ${legacy.userId}, 'OWNER')`;

    await sql.unsafe(migration);
    await sql.unsafe(migration);

    const { destinations, rules } = await defaultChannel(legacy.workspaceId);
    expect(destinations).toHaveLength(1);
    expect(destinations[0]).toMatchObject({
      type: "EMAIL",
      name: "Account email",
      endpoint: legacy.email.toLowerCase(),
      mode: "notify_only",
      mapped_user_id: legacy.userId,
    });
    expect(String(destinations[0]!.id)).toMatch(/^[A-Za-z]{12}$/);
    expect(destinations[0]!.verified_at).not.toBeNull();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ destination_id: destinations[0]!.id, action_kind: "*", active: true });
    expect(String(rules[0]!.destination_id)).toMatch(/^[A-Za-z]{12}$/);

    const signupWorkspace = await defaultChannel(workspaceId);
    expect(signupWorkspace.destinations).toHaveLength(1);
    expect(signupWorkspace.rules).toHaveLength(1);
  });
});
