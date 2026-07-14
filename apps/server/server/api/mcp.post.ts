import { CreateApproval, Id, canonicalDigest, createId } from "@mayi/contracts";
import { freezeDigests, isHighRisk, validateActionForEnforcement, validateSuggestedApprover } from "@mayi/domain";
import { defineEventHandler, readBody } from "h3";
import { z } from "zod";
import { audit, requireAgent } from "../utils/auth";
import { database } from "../utils/runtime";
import { serializeApproval } from "../utils/serialize";

const Call = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() });

const tools = [
  { name: "create_approval", description: "Create and seal an exact approval request without evidence. Use HTTP uploads for evidence.", inputSchema: { type: "object", required: ["action", "explanation", "idempotencyKey"], properties: { action: { type: "object" }, explanation: { type: "string" }, expiresInSeconds: { type: "integer" }, enforcement: { enum: ["cooperative", "verified", "consumed"] }, suggestedApproverId: { type: "string", pattern: "^[A-Za-z]{12}$" }, idempotencyKey: { type: "string" } } } },
  { name: "get_approval", description: "Read authoritative approval state and receipt.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[A-Za-z]{12}$" } } } },
  { name: "cancel_approval", description: "Cancel an owned draft or pending approval.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[A-Za-z]{12}$" } } } },
];

function result(id: string | number | undefined, value: unknown) { return { jsonrpc: "2.0", id: id ?? null, result: value }; }
function toolResult(value: unknown) { return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }; }

export default defineEventHandler(async (event) => {
  const auth = await requireAgent(event);
  const request = Call.parse(await readBody(event));
  if (request.method === "initialize") return result(request.id, { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "may-i", version: "0.1.0" } });
  if (request.method === "notifications/initialized") return { jsonrpc: "2.0" };
  if (request.method === "ping") return result(request.id, {});
  if (request.method === "tools/list") return result(request.id, { tools });
  if (request.method !== "tools/call") return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32601, message: "Method not found" } };
  const name = String(request.params?.name ?? "");
  const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
  if (name === "create_approval") {
    if (!auth.scopes.includes("approval:create")) return result(request.id, { isError: true, content: [{ type: "text", text: "Missing approval:create scope" }] });
    const idempotencyKey = z.string().min(1).max(200).parse(args.idempotencyKey);
    const input = CreateApproval.parse(args);
    try { validateActionForEnforcement(input.action, input.enforcement); }
    catch (error) { return result(request.id, { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Invalid exact action" }] }); }
    const payloadHash = await canonicalDigest(input);
    const id = await database().sql.begin("isolation level serializable", async (sql) => {
      const existing = await sql`select payload_hash, response from idempotency_keys where workspace_id = ${auth.workspaceId} and credential_id = ${auth.agentId} and operation = 'approval.create' and key = ${idempotencyKey} for update`;
      if (existing[0]) {
        if (existing[0].payload_hash !== payloadHash) throw new Error("Idempotency key reused with different content");
        return String((existing[0].response as { id: string }).id);
      }
      const [workspace] = await sql`select policy_version from workspaces where id = ${auth.workspaceId} for share`;
      const eligible = await sql`select m.user_id from memberships m join users u on u.id = m.user_id and u.active and u.deleted_at is null where m.workspace_id = ${auth.workspaceId} and m.active and m.revoked_at is null and m.role in ('OWNER','APPROVER')`;
      validateSuggestedApprover(input.suggestedApproverId, eligible.map((row) => String(row.user_id)));
      if (!eligible.length) throw new Error("No eligible approver exists");
      const digests = await freezeDigests(input.action, []);
      const approvalId = createId();
      const [approval] = await sql`
        insert into approvals (id, workspace_id, agent_id, state, action, explanation, enforcement, action_digest, manifest_digest, policy_version, high_risk, expires_at, sealed_at)
        values (${approvalId}, ${auth.workspaceId}, ${auth.agentId}, 'PENDING', ${JSON.stringify(input.action)}::jsonb, ${input.explanation}, ${input.enforcement}, ${digests.actionDigest}, ${digests.manifestDigest}, ${workspace!.policy_version}, ${isHighRisk(input.action)}, now() + make_interval(secs => ${input.expiresInSeconds}), now()) returning id
      `;
      const storedApprovalId = String(approval!.id);
      for (const row of eligible) await sql`insert into eligible_approvers (approval_id, workspace_id, user_id) values (${storedApprovalId}, ${auth.workspaceId}, ${row.user_id})`;
      await sql`insert into idempotency_keys (workspace_id, credential_id, operation, key, payload_hash, response, expires_at) values (${auth.workspaceId}, ${auth.agentId}, 'approval.create', ${idempotencyKey}, ${payloadHash}, ${JSON.stringify({ id: storedApprovalId })}::jsonb, now() + interval '24 hours')`;
      await sql`insert into jobs (id, workspace_id, type, dedupe_key, payload) values (${createId()}, ${auth.workspaceId}, 'push.approval_pending', ${storedApprovalId}, ${JSON.stringify({ approvalId: storedApprovalId })}::jsonb) on conflict do nothing`;
      const rules = await sql`select r.destination_id, d.type from forwarding_rules r join forwarding_destinations d on d.id = r.destination_id where r.workspace_id = ${auth.workspaceId} and r.active and d.active and d.verified_at is not null and (r.action_kind = '*' or r.action_kind = ${input.action.kind})`;
      for (const rule of rules) {
        const deliveries = await sql`insert into forwarding_deliveries (id, workspace_id, approval_id, destination_id, origin_id) values (${createId()}, ${auth.workspaceId}, ${storedApprovalId}, ${rule.destination_id}, ${storedApprovalId}) on conflict do nothing returning id`;
        if (deliveries[0]) await sql`insert into jobs (id, workspace_id, type, dedupe_key, payload) values (${createId()}, ${auth.workspaceId}, ${rule.type === "EMAIL" ? "email.approval_pending" : "webhook.approval_pending"}, ${`${storedApprovalId}:${rule.destination_id}`}, ${JSON.stringify({ approvalId: storedApprovalId, destinationId: String(rule.destination_id), deliveryId: String(deliveries[0].id) })}::jsonb) on conflict do nothing`;
      }
      await audit({ workspaceId: auth.workspaceId, actorType: "agent", actorId: auth.agentId, eventType: "approval.sealed", subjectType: "approval", subjectId: storedApprovalId, metadata: digests }, sql);
      return storedApprovalId;
    });
    return result(request.id, toolResult(await serializeApproval(auth.workspaceId, id)));
  }
  if (name === "get_approval") {
    if (!auth.scopes.includes("approval:read")) return result(request.id, { isError: true, content: [{ type: "text", text: "Missing approval:read scope" }] });
    const id = Id.parse(args.id);
    const own = await database().sql`select 1 from approvals where id = ${id} and workspace_id = ${auth.workspaceId} and agent_id = ${auth.agentId}`;
    return result(request.id, toolResult(own.length ? await serializeApproval(auth.workspaceId, id) : null));
  }
  if (name === "cancel_approval") {
    if (!auth.scopes.includes("approval:cancel")) return result(request.id, { isError: true, content: [{ type: "text", text: "Missing approval:cancel scope" }] });
    const id = Id.parse(args.id);
    await database().sql`update approvals set state = 'CANCELLED', cancelled_at = now(), decided_at = now() where id = ${id} and workspace_id = ${auth.workspaceId} and agent_id = ${auth.agentId} and state in ('DRAFT','PENDING')`;
    return result(request.id, toolResult(await serializeApproval(auth.workspaceId, id)));
  }
  return result(request.id, { isError: true, content: [{ type: "text", text: "Unknown tool" }] });
});
