import { InputRequest, canonicalDigest, createId } from "@mayi/contracts";
import { validateSuggestedApprover } from "@mayi/domain";
import { createError, defineEventHandler } from "h3";
import { authorizeApprovalCallback } from "../../utils/approval-callback";
import { audit, requireAgent } from "../../utils/auth";
import { asHttpError, bodyAs, requireIdempotencyKey } from "../../utils/http";
import { queueInputNotifications } from "../../utils/pending-notifications";
import { database } from "../../utils/runtime";
import { serializeInput } from "../../utils/serialize";

const OPERATION = "input.request";

export default defineEventHandler(async (event) => {
  const auth = await requireAgent(event, "approval:create");
  const key = requireIdempotencyKey(event);
  const input = await bodyAs(event, InputRequest);
  // Callback state is randomized opaque ciphertext. It is first-write-wins and is not
  // semantic request content, so a lost-response retry may safely carry a new ciphertext.
  const payloadHash = await canonicalDigest(input.callback
    ? { ...input, callback: { url: input.callback.url } }
    : input);

  // An exact replay has already passed callback authorization and SSRF checks. Returning
  // it before DNS validation makes retries reliable even when DNS is temporarily down.
  const replay = await database().sql`
    select payload_hash, response
    from idempotency_keys
    where workspace_id = ${auth.workspaceId}
      and credential_id = ${auth.agentId}
      and operation = ${OPERATION}
      and key = ${key}
  `;
  if (replay[0]) {
    if (replay[0].payload_hash !== payloadHash) {
      throw createError({ statusCode: 409, statusMessage: "Idempotency key was reused with different content" });
    }
    return replay[0].response;
  }

  if (input.callback) await authorizeApprovalCallback(auth, input.callback.url);

  return await database().sql.begin(async (sql) => {
    // Serialize only callers competing for this credential/key. Without this lock, two
    // first uses could both pass the missing-row check before either inserts the key.
    const lockKey = `${auth.workspaceId}:${auth.agentId}:${OPERATION}:${key}`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

    const previous = await sql`
      select payload_hash, response
      from idempotency_keys
      where workspace_id = ${auth.workspaceId}
        and credential_id = ${auth.agentId}
        and operation = ${OPERATION}
        and key = ${key}
      for update
    `;
    if (previous[0]) {
      if (previous[0].payload_hash !== payloadHash) {
        throw createError({ statusCode: 409, statusMessage: "Idempotency key was reused with different content" });
      }
      return previous[0].response;
    }

    const [workspace] = await sql`
      select id from workspaces where id = ${auth.workspaceId} for share
    `;
    if (!workspace) throw createError({ statusCode: 404, statusMessage: "Workspace not found" });

    const eligible = await sql`
      select m.user_id
      from memberships m
      join users u on u.id = m.user_id and u.active and u.deleted_at is null
      where m.workspace_id = ${auth.workspaceId}
        and m.active
        and m.revoked_at is null
        and m.role in ('OWNER', 'APPROVER')
    `;
    if (!eligible.length) {
      throw createError({ statusCode: 409, statusMessage: "No eligible respondent exists under current policy" });
    }
    try {
      validateSuggestedApprover(input.suggestedApproverId, eligible.map((row) => String(row.user_id)));
    } catch (error) {
      asHttpError(error);
    }

    const id = createId();
    await sql`
      insert into inputs (
        id, workspace_id, agent_id, type, prompt, options, allow_freeform,
        state, suggested_approver_id, expires_at
      ) values (
        ${id}, ${auth.workspaceId}, ${auth.agentId}, ${input.type}, ${input.prompt},
        ${input.options ? JSON.stringify(input.options) : null}::jsonb,
        ${input.type === "select" && input.allowFreeform === true},
        'PENDING', ${input.suggestedApproverId ?? null},
        now() + make_interval(secs => ${input.expiresInSeconds})
      )
    `;
    if (input.callback) {
      await sql`
        insert into input_callbacks (id, input_id, workspace_id, url, state)
        values (${createId()}, ${id}, ${auth.workspaceId}, ${input.callback.url}, ${input.callback.state})
      `;
    }
    for (const row of eligible) {
      await sql`
        insert into input_eligible_respondents (input_id, workspace_id, user_id)
        values (${id}, ${auth.workspaceId}, ${row.user_id})
      `;
    }
    await queueInputNotifications(sql, { workspaceId: auth.workspaceId, inputId: id, type: input.type, prompt: input.prompt });
    const response = await serializeInput(auth.workspaceId, id, sql);
    if (!response) {
      throw createError({ statusCode: 500, statusMessage: "Created input could not be serialized" });
    }
    await sql`
      insert into idempotency_keys (
        workspace_id, credential_id, operation, key, payload_hash, response, expires_at
      ) values (
        ${auth.workspaceId}, ${auth.agentId}, ${OPERATION}, ${key}, ${payloadHash},
        ${JSON.stringify(response)}::jsonb, now() + interval '24 hours'
      )
    `;
    await audit({
      workspaceId: auth.workspaceId,
      actorType: "agent",
      actorId: auth.agentId,
      eventType: "input.requested",
      subjectType: "input",
      subjectId: id,
      metadata: { type: input.type },
    }, sql);
    return response;
  });
});
