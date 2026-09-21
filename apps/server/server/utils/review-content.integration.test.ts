import { createId, reviewDigest, type ApprovalRequest } from "@mayi/contracts";
import { createApp, createRouter, toWebHandler } from "h3";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import getApproval from "../api/approvals/[id].get";
import decision from "../api/approvals/[id]/decision.post";
import seal from "../api/approvals/[id]/seal.post";
import createDraft from "../api/approvals/index.post";
import requestApproval from "../api/approvals/request.post";
import mcp from "../api/mcp.post";
import { CALLBACK_JOB_TYPE, claimNextJob, sendApprovalCallback } from "./callback-outbox";
import { tokenHash } from "./crypto";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;
process.env.WEB_ORIGIN = "https://review.example/";
process.env.SESSION_COOKIE_SECURE = "false";

const CALLBACK = "https://8.8.8.8/eve/v1/mayi/approval-resolved";
const ids = {
  workspace: createId(), otherWorkspace: createId(), user: createId(), client: createId(),
  agent: createId(), otherAgent: createId(), foreignAgent: createId(), session: createId(),
};
const tokens = {
  agent: `review-agent-${createId()}`,
  otherAgent: `review-other-${createId()}`,
  foreignAgent: `review-foreign-${createId()}`,
  session: `mayi_session_review_${createId()}`,
};

const router = createRouter()
  .post("/api/approvals/request", requestApproval)
  .post("/api/approvals", createDraft)
  .post("/api/approvals/:id/seal", seal)
  .post("/api/approvals/:id/decision", decision)
  .get("/api/approvals/:id", getApproval)
  .post("/api/mcp", mcp);
const app = createApp();
app.use(router);
const handle = toWebHandler(app);

type ApprovalBody = Record<string, unknown> & { id: string; state: string };

function baseRequest(): ApprovalRequest {
  return {
    action: { kind: "tool-call", toolName: "open_pull_request", callId: createId(), input: { branch: "feat/x" } },
    explanation: "Open the pull request for the reviewed change.",
    expiresInSeconds: 3_600,
    callback: { url: CALLBACK, state: "opaque-state" },
  };
}

function post(path: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  return handle(new Request(`http://mayi.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}

function request(body: unknown, options: { token?: string; key?: string } = {}): Promise<Response> {
  return post("/api/approvals/request", body, {
    authorization: `Bearer ${options.token ?? tokens.agent}`,
    "idempotency-key": options.key ?? createId(),
  });
}

async function requested(body: unknown, options: { token?: string; key?: string } = {}): Promise<ApprovalBody> {
  const response = await request(body, options);
  expect(response.status).toBe(200);
  return await response.json() as ApprovalBody;
}

function decide(approvalId: string, body: unknown): Promise<Response> {
  return post(`/api/approvals/${approvalId}/decision`, body, {
    authorization: `Bearer ${tokens.session}`,
    "x-workspace-id": ids.workspace,
  });
}

async function read(approvalId: string, token = tokens.agent): Promise<Response> {
  return handle(new Request(`http://mayi.test/api/approvals/${approvalId}`, {
    headers: { authorization: `Bearer ${token}` },
  }));
}

async function resolvedApproval(): Promise<ApprovalBody> {
  const approval = await requested(baseRequest());
  expect((await decide(approval.id, { decision: "DENIED" })).status).toBe(200);
  return approval;
}

describe.sequential("review content and revisions", () => {
  beforeAll(async () => {
    const sql = database().sql;
    await sql`
      insert into users (id, email, display_name, password_hash)
      values (${ids.user}, ${`review-content-${ids.user}@example.com`}, 'Reviewer', 'unused')
    `;
    await sql`
      insert into workspaces (id, name) values
        (${ids.workspace}, 'Review content'), (${ids.otherWorkspace}, 'Other review workspace')
    `;
    await sql`
      insert into memberships (workspace_id, user_id, role) values
        (${ids.workspace}, ${ids.user}, 'OWNER'), (${ids.otherWorkspace}, ${ids.user}, 'OWNER')
    `;
    await sql`
      insert into oauth_clients (id, name, redirect_uris, approval_callback_uris, registration_ip_hash)
      values (${ids.client}, 'Review client', ${["https://client.example/cb"]}, ${[CALLBACK]}, ${"r".repeat(64)})
    `;
    const scopes = ["approval:create", "approval:read"];
    await sql`
      insert into agents (id, workspace_id, name, client_id, scopes, credential_hash, created_by) values
        (${ids.agent}, ${ids.workspace}, 'Review agent', ${ids.client}, ${scopes}, ${await tokenHash(tokens.agent)}, ${ids.user}),
        (${ids.otherAgent}, ${ids.workspace}, 'Other agent', ${ids.client}, ${scopes}, ${await tokenHash(tokens.otherAgent)}, ${ids.user}),
        (${ids.foreignAgent}, ${ids.otherWorkspace}, 'Foreign agent', ${ids.client}, ${scopes}, ${await tokenHash(tokens.foreignAgent)}, ${ids.user})
    `;
    await sql`
      insert into sessions (id, user_id, token_hash, recent_auth_at, expires_at)
      values (${ids.session}, ${ids.user}, ${await tokenHash(tokens.session)}, now(), now() + interval '1 hour')
    `;
  });

  afterAll(async () => {
    const sql = database().sql;
    await sql`delete from workspaces where id in (${ids.workspace}, ${ids.otherWorkspace})`;
    await sql`delete from oauth_clients where id = ${ids.client}`;
    await sql`delete from users where id = ${ids.user}`;
    await database().close();
  });

  it("persists review content, freezes its digest and links to the review page", async () => {
    const input = {
      ...baseRequest(),
      title: "Add review documents to approvals",
      reviewMarkdown: "## Summary\n\n| file | change |\n| --- | --- |\n| schema.ts | columns |",
    };
    const approval = await requested(input);

    const expectedDigest = await reviewDigest(input);
    expect(approval).toMatchObject({
      title: input.title,
      reviewMarkdown: input.reviewMarkdown,
      reviewDigest: expectedDigest,
      supersedesApprovalId: null,
      supersededByApprovalId: null,
      decisionOutcome: null,
      reviewUrl: `https://review.example/?approval=${approval.id}`,
    });
    const reread = await (await read(approval.id)).json() as ApprovalBody;
    expect(reread).toMatchObject({ title: input.title, reviewMarkdown: input.reviewMarkdown, reviewDigest: expectedDigest });
    const [audit] = await database().sql`
      select metadata from audit_events where subject_id = ${approval.id} and event_type = 'approval.sealed'
    `;
    expect(audit!.metadata).toMatchObject({ reviewDigest: expectedDigest });
  });

  it("digests the explanation alone when no review content is given", async () => {
    const input = baseRequest();
    const approval = await requested(input);
    expect(approval).toMatchObject({ title: null, reviewMarkdown: null });
    expect(approval.reviewDigest).toBe(await reviewDigest({ explanation: input.explanation }));
  });

  it("binds review content into the idempotency fingerprint", async () => {
    const input = { ...baseRequest(), title: "First title" };
    const key = createId();
    const first = await requested(input, { key });
    expect(await requested(input, { key })).toEqual(first);
    expect((await request({ ...input, title: "Second title" }, { key })).status).toBe(409);
    expect((await request({ ...input, reviewMarkdown: "Added later" }, { key })).status).toBe(409);
  });

  it("rejects invalid review content before creating anything", async () => {
    const explanation = `Invalid review ${createId()}`;
    const response = await request({ ...baseRequest(), explanation, title: "two\nlines" });
    expect(response.status).toBe(422);
    expect(await database().sql`select id from approvals where explanation = ${explanation}`).toHaveLength(0);
  });

  it("requires feedback to request changes and leaves the approval pending without it", async () => {
    const approval = await requested(baseRequest());
    expect((await decide(approval.id, { decision: "CHANGES_REQUESTED" })).status).toBe(422);
    expect((await decide(approval.id, { decision: "CHANGES_REQUESTED", comment: "   " })).status).toBe(422);
    const [row] = await database().sql`select state, decision_outcome from approvals where id = ${approval.id}`;
    expect(row).toMatchObject({ state: "PENDING", decision_outcome: null });
  });

  it("records requested changes as a denial with feedback, no receipt and a denied callback", async () => {
    const approval = await requested({ ...baseRequest(), title: "Revise me" });
    const feedback = "Split the migration from the endpoint change.";

    const response = await decide(approval.id, { decision: "CHANGES_REQUESTED", comment: feedback });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "DENIED", decisionOutcome: "CHANGES_REQUESTED", decisionComment: feedback, approverId: ids.user,
    });
    expect(await database().sql`select id from receipts where approval_id = ${approval.id}`).toHaveLength(0);

    // The integration reads the feedback with its own agent token.
    const seen = await (await read(approval.id)).json() as ApprovalBody;
    expect(seen).toMatchObject({ state: "DENIED", decisionOutcome: "CHANGES_REQUESTED", decisionComment: feedback });
    expect(seen.decidedAt).toEqual(expect.any(String));
    expect(seen).not.toHaveProperty("receipt");

    const [audit] = await database().sql`
      select actor_id from audit_events where subject_id = ${approval.id} and event_type = 'approval.changes_requested'
    `;
    expect(String(audit!.actor_id)).toBe(ids.user);

    const [queued] = await database().sql`
      select j.id from jobs j join approval_callbacks c on j.dedupe_key = c.id
      where j.type = ${CALLBACK_JOB_TYPE} and c.approval_id = ${approval.id}
    `;
    const job = await claimNextJob(database().sql, { jobId: String(queued!.id) });
    const sent = await sendApprovalCallback(job!, {
      resolve: async () => ["8.8.8.8"],
      transport: async () => ({ status: 204, bytes: 0 }),
    });
    expect(sent.event).toMatchObject({ status: "denied", state: "opaque-state", approver: { id: ids.user } });
    expect(sent.event).not.toHaveProperty("receipt");
  });

  it("records plain approvals and denials as their own outcome", async () => {
    const denied = await requested(baseRequest());
    expect(await (await decide(denied.id, { decision: "DENIED" })).json()).toMatchObject({
      state: "DENIED", decisionOutcome: "DENIED",
    });
  });

  it("carries the frozen review digest in an approved receipt", async () => {
    const input = { ...baseRequest(), title: "Merge the reviewed branch", reviewMarkdown: "Diff summary." };
    const approval = await requested(input);
    const decided = await (await decide(approval.id, { decision: "APPROVED" })).json() as ApprovalBody;
    expect(decided).toMatchObject({ state: "APPROVED", decisionOutcome: "APPROVED" });
    const claims = decodeJwt(String(decided.receipt));
    expect(claims.review_digest).toBe(await reviewDigest(input));
    expect(claims.review_digest).toBe(approval.reviewDigest);
  });

  it("links a revision to the resolved approval it supersedes", async () => {
    const previous = await resolvedApproval();
    const revision = await requested({ ...baseRequest(), supersedesApprovalId: previous.id });
    expect(revision.supersedesApprovalId).toBe(previous.id);
    const reread = await (await read(previous.id)).json() as ApprovalBody;
    expect(reread.supersededByApprovalId).toBe(revision.id);
  });

  it("refuses to revise an approval that is still pending", async () => {
    const pending = await requested(baseRequest());
    expect((await request({ ...baseRequest(), supersedesApprovalId: pending.id })).status).toBe(409);
  });

  it("refuses to revise another agent's, another workspace's or a missing approval", async () => {
    const previous = await resolvedApproval();
    const otherAgent = await request({ ...baseRequest(), supersedesApprovalId: previous.id }, { token: tokens.otherAgent });
    expect(otherAgent.status).toBe(422);
    const foreign = await request({ ...baseRequest(), supersedesApprovalId: previous.id }, { token: tokens.foreignAgent });
    expect(foreign.status).toBe(422);
    expect((await request({ ...baseRequest(), supersedesApprovalId: createId() })).status).toBe(422);
    expect((await (await read(previous.id)).json() as ApprovalBody).supersededByApprovalId).toBeNull();
  });

  it("allows exactly one revision per approval, even under concurrency", async () => {
    const previous = await resolvedApproval();
    const responses = await Promise.all(Array.from({ length: 3 }, () =>
      request({ ...baseRequest(), supersedesApprovalId: previous.id })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409]);
    expect((await request({ ...baseRequest(), supersedesApprovalId: previous.id })).status).toBe(409);
    const successors = await database().sql`select id from approvals where supersedes_approval_id = ${previous.id}`;
    expect(successors).toHaveLength(1);
  });

  it("keeps review content through the draft and seal flow", async () => {
    const previous = await resolvedApproval();
    const input = {
      action: { kind: "tool-call", toolName: "deploy", callId: createId(), input: {} },
      explanation: "Deploy the revised change.",
      title: "Deploy revision 2",
      reviewMarkdown: "Addresses the requested changes.",
      supersedesApprovalId: previous.id,
    };
    const draftResponse = await post("/api/approvals", input, {
      authorization: `Bearer ${tokens.agent}`, "idempotency-key": createId(),
    });
    expect(draftResponse.status).toBe(200);
    const draft = await draftResponse.json() as ApprovalBody;
    const sealed = await (await post(`/api/approvals/${draft.id}/seal`, {}, { authorization: `Bearer ${tokens.agent}` })).json() as ApprovalBody;
    expect(sealed).toMatchObject({
      state: "PENDING",
      title: input.title,
      reviewMarkdown: input.reviewMarkdown,
      supersedesApprovalId: previous.id,
      reviewDigest: await reviewDigest(input),
    });
    const [audit] = await database().sql`
      select metadata from audit_events where subject_id = ${draft.id} and event_type = 'approval.sealed'
    `;
    expect(audit!.metadata).toMatchObject({ reviewDigest: sealed.reviewDigest });
  });

  it("accepts review content through the MCP create_approval tool", async () => {
    const args = {
      action: { kind: "tool-call", toolName: "deploy", callId: createId(), input: {} },
      explanation: "Deploy via MCP.",
      title: "MCP deploy",
      reviewMarkdown: "Created by an MCP client.",
      idempotencyKey: createId(),
    };
    const response = await post("/api/mcp", {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_approval", arguments: args },
    }, { authorization: `Bearer ${tokens.agent}` });
    const body = await response.json() as { result: { structuredContent: ApprovalBody } };
    expect(body.result.structuredContent).toMatchObject({
      state: "PENDING", title: args.title, reviewMarkdown: args.reviewMarkdown, reviewDigest: await reviewDigest(args),
    });
  });

  it("refuses any later change to what the reviewer read", async () => {
    const approval = await requested({ ...baseRequest(), title: "Frozen", reviewMarkdown: "Frozen body" });
    const sql = database().sql;
    await expect(sql`update approvals set title = 'Changed' where id = ${approval.id}`).rejects.toThrow(/immutable/);
    await expect(sql`update approvals set review_markdown = 'Changed' where id = ${approval.id}`).rejects.toThrow(/immutable/);
    await expect(sql`update approvals set explanation = 'Changed' where id = ${approval.id}`).rejects.toThrow(/immutable/);
    await expect(sql`update approvals set review_digest = ${"0".repeat(64)} where id = ${approval.id}`).rejects.toThrow(/immutable/);
    await expect(sql`update approvals set action = '{}'::jsonb where id = ${approval.id}`).rejects.toThrow(/immutable/);
    const previous = await resolvedApproval();
    await expect(sql`update approvals set supersedes_approval_id = ${previous.id} where id = ${approval.id}`).rejects.toThrow(/immutable/);
    // Lifecycle columns stay writable.
    await sql`update approvals set expires_at = expires_at + interval '1 minute' where id = ${approval.id}`;
    const [row] = await sql`select title, review_markdown from approvals where id = ${approval.id}`;
    expect(row).toMatchObject({ title: "Frozen", review_markdown: "Frozen body" });
  });

  it("enforces the outcome invariants in the database", async () => {
    const sql = database().sql;
    const approval = await requested(baseRequest());
    await expect(sql`
      update approvals set state = 'APPROVED', decision_outcome = 'CHANGES_REQUESTED', decided_at = now(), decision_comment = 'x'
      where id = ${approval.id}
    `).rejects.toThrow(/check/);
    await expect(sql`
      update approvals set state = 'DENIED', decision_outcome = 'CHANGES_REQUESTED', decided_at = now()
      where id = ${approval.id}
    `).rejects.toThrow(/check/);
    await expect(sql`
      update approvals set state = 'DENIED', decided_at = now() where id = ${approval.id}
    `).rejects.toThrow(/check/);
  });

  it("isolates review content by tenant under the application role", async () => {
    const approval = await requested({ ...baseRequest(), title: "Tenant scoped" });
    const visible = async (workspaceId: string) => database().sql.begin(async (sql) => {
      await sql`set local role mayi_app`;
      await sql`select set_config('app.workspace_id', ${workspaceId}, true)`;
      return sql`select title, review_digest from approvals where id = ${approval.id}`;
    });
    expect(await visible(ids.otherWorkspace)).toHaveLength(0);
    expect(await visible(ids.workspace)).toEqual([{ title: "Tenant scoped", review_digest: approval.reviewDigest }]);
  });
});
