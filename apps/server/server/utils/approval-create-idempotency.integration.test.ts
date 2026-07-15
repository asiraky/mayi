import { createId } from "@mayi/contracts";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import createDraft from "../api/approvals/index.post";
import mcp from "../api/mcp.post";
import { tokenHash } from "./crypto";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;

const ids = { workspace: createId(), user: createId(), agent: createId() };
const token = `create-idempotency-${createId()}`;
const input = {
  action: { kind: "tool-call" as const, toolName: "deploy", callId: "call-1", input: { version: "1.2.3" } },
  explanation: "Deploy the exact tested version",
  enforcement: "cooperative" as const,
  expiresInSeconds: 3_600,
};

const router = createRouter();
router.post("/api/approvals", createDraft);
router.post("/api/mcp", mcp);
const app = createApp();
app.use(router);
const handle = toWebHandler(app);

function draft(key: string, value: unknown = input): Promise<Response> {
  return handle(new Request("http://mayi.test/api/approvals", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(value),
  }));
}

function createThroughMcp(key: string, value: Record<string, unknown> = input): Promise<Response> {
  return handle(new Request("http://mayi.test/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create_approval", arguments: { ...value, idempotencyKey: key } },
    }),
  }));
}

async function mcpApproval(response: Response): Promise<{ id: string; state: string }> {
  const body = await response.json() as {
    result: { structuredContent: { id: string; state: string } };
  };
  return body.result.structuredContent;
}

describe.sequential("legacy and MCP approval creation idempotency", () => {
  beforeAll(async () => {
    await database().sql`
      insert into users (id, email, display_name, password_hash)
      values (${ids.user}, ${`create-idempotency-${ids.user}@example.com`}, 'Create owner', 'unused')
    `;
    await database().sql`insert into workspaces (id, name) values (${ids.workspace}, 'Create idempotency')`;
    await database().sql`
      insert into memberships (workspace_id, user_id, role) values (${ids.workspace}, ${ids.user}, 'OWNER')
    `;
    await database().sql`
      insert into agents (id, workspace_id, name, scopes, credential_hash, created_by)
      values (${ids.agent}, ${ids.workspace}, 'Create agent', ${["approval:create"]}, ${await tokenHash(token)}, ${ids.user})
    `;
  });

  afterAll(async () => {
    await database().sql`delete from workspaces where id = ${ids.workspace}`;
    await database().sql`delete from users where id = ${ids.user}`;
    await database().close();
  });

  it("collapses concurrent first-use draft requests", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => draft("parallel-draft")));
    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(200));
    const approvals = await Promise.all(responses.map((response) => response.json() as Promise<{ id: string; state: string }>));
    expect(new Set(approvals.map(({ id }) => id)).size).toBe(1);
    expect(approvals[0]!.state).toBe("DRAFT");
  });

  it("collapses concurrent first-use MCP requests", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => createThroughMcp("parallel-mcp")));
    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(200));
    const approvals = await Promise.all(responses.map(mcpApproval));
    expect(new Set(approvals.map(({ id }) => id)).size).toBe(1);
    expect(approvals[0]!.state).toBe("PENDING");
    const jobs = await database().sql`
      select id from jobs where type = 'push.approval_pending' and payload->>'approvalId' = ${approvals[0]!.id}
    `;
    expect(jobs).toHaveLength(1);
  });

  it("gives draft and MCP creation independent namespaces", async () => {
    const key = "same-key-different-contract";
    const draftResponse = await draft(key);
    const mcpResponse = await createThroughMcp(key);
    const draftApproval = await draftResponse.json() as { id: string; state: string };
    const mcpCreated = await mcpApproval(mcpResponse);
    expect([draftResponse.status, mcpResponse.status]).toEqual([200, 200]);
    expect(draftApproval).toMatchObject({ state: "DRAFT" });
    expect(mcpCreated).toMatchObject({ state: "PENDING" });
    expect(mcpCreated.id).not.toBe(draftApproval.id);
    const operations = await database().sql`
      select operation from idempotency_keys
      where workspace_id = ${ids.workspace} and key = ${key}
      order by operation
    `;
    expect(operations.map(({ operation }) => operation)).toEqual(["approval.create.mcp", "approval.draft"]);
  });

  it.each([
    ["draft", draft],
    ["MCP", createThroughMcp],
  ] as const)("rejects changed %s content under the same key", async (_surface, post) => {
    const key = `changed-${_surface}`;
    expect((await post(key)).status).toBe(200);
    expect((await post(key, { ...input, explanation: "Changed request" })).status).toBe(409);
  });
});
