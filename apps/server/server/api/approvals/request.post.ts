import { ApprovalRequest, canonicalDigest, createId } from "@mayi/contracts";
import { freezeDigests, isHighRisk, validateActionForEnforcement, validateSuggestedApprover } from "@mayi/domain";
import { createError, defineEventHandler } from "h3";
import { authorizeApprovalCallback } from "../../utils/approval-callback";
import { audit, requireAgent } from "../../utils/auth";
import { asHttpError, bodyAs, requireIdempotencyKey } from "../../utils/http";
import { queuePendingNotifications } from "../../utils/pending-notifications";
import { storedArtefactMatches, type ArtefactMediaType } from "../../utils/artefacts";
import { database, objects } from "../../utils/runtime";
import { serializeApproval } from "../../utils/serialize";

const OPERATION = "approval.request";

export default defineEventHandler(async (event) => {
  const auth = await requireAgent(event, "approval:create");
  const key = requireIdempotencyKey(event);
  const input = await bodyAs(event, ApprovalRequest);
  try {
    validateActionForEnforcement(input.action, "cooperative");
  } catch (error) {
    asHttpError(error);
  }
  if (input.artefactIds && new Set(input.artefactIds).size !== input.artefactIds.length) {
    throw createError({ statusCode: 422, statusMessage: "Artefacts may only appear once" });
  }
  // Callback state is randomized opaque ciphertext. It is first-write-wins and is not
  // semantic request content, so a lost-response retry may safely carry a new ciphertext.
  const payloadHash = await canonicalDigest({
    ...input,
    callback: { url: input.callback.url },
  });

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
    return await serializeApproval(auth.workspaceId, String((replay[0].response as { id: string }).id));
  }

  await authorizeApprovalCallback(auth, input.callback.url);

  const approvalId = await database().sql.begin(async (sql) => {
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
      return String((previous[0].response as { id: string }).id);
    }

    const [workspace] = await sql`
      select policy_version from workspaces where id = ${auth.workspaceId} for share
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
      throw createError({ statusCode: 409, statusMessage: "No eligible approver exists under current policy" });
    }
    try {
      validateSuggestedApprover(input.suggestedApproverId, eligible.map((row) => String(row.user_id)));
    } catch (error) {
      asHttpError(error);
    }

    const artefactIds = input.artefactIds ?? [];
    const files = artefactIds.length ? await sql`
      select id, object_key, filename, media_type, size, sha256, upload_ordinal
      from artefacts
      where workspace_id = ${auth.workspaceId}
        and agent_id = ${auth.agentId}
        and request_key = ${key}
        and id in ${sql(artefactIds)}
        and approval_id is null
        and state = 'READY'
        and expires_at > now()
      for update
    ` : [];
    if (files.length !== artefactIds.length) {
      throw createError({ statusCode: 422, statusMessage: "Every artefact must be ready and staged for this request" });
    }
    const store = objects();
    for (const file of files) {
      if (!await storedArtefactMatches(store, {
        objectKey: String(file.object_key),
        mediaType: String(file.media_type) as ArtefactMediaType,
        size: Number(file.size),
        sha256: String(file.sha256),
      })) {
        throw createError({ statusCode: 409, statusMessage: "A staged artefact is unavailable or does not match its immutable metadata" });
      }
    }
    const byId = new Map(files.map((file) => [String(file.id), file]));
    const manifest = artefactIds.map((artefactId, ordinal) => {
      const file = byId.get(artefactId)!;
      if (Number(file.upload_ordinal) !== ordinal) {
        throw createError({ statusCode: 422, statusMessage: "Artefact order must match its staged ordinal" });
      }
      return {
        id: artefactId,
        ordinal,
        filename: String(file.filename),
        mediaType: String(file.media_type) as "application/pdf" | "image/png" | "image/jpeg" | "image/webp",
        size: Number(file.size),
        sha256: String(file.sha256),
      };
    });
    const digests = await freezeDigests(input.action, manifest);
    const id = createId();
    await sql`
      insert into approvals (
        id, workspace_id, agent_id, state, action, explanation, enforcement,
        action_digest, manifest_digest, policy_version, high_risk, expires_at, sealed_at
      ) values (
        ${id}, ${auth.workspaceId}, ${auth.agentId}, 'PENDING', ${JSON.stringify(input.action)}::jsonb,
        ${input.explanation}, 'cooperative', ${digests.actionDigest}, ${digests.manifestDigest},
        ${workspace.policy_version}, ${isHighRisk(input.action)},
        now() + make_interval(secs => ${input.expiresInSeconds}), now()
      )
    `;
    await sql`
      insert into approval_callbacks (id, approval_id, workspace_id, url, state)
      values (${createId()}, ${id}, ${auth.workspaceId}, ${input.callback.url}, ${input.callback.state})
    `;
    for (const item of manifest) {
      const claimed = await sql`
        update artefacts set approval_id = ${id}
        where id = ${item.id} and approval_id is null
        returning id
      `;
      if (claimed.length !== 1) {
        throw createError({ statusCode: 409, statusMessage: "Artefact was claimed by another request" });
      }
      await sql`
        insert into approval_artefacts (approval_id, artefact_id, ordinal)
        values (${id}, ${item.id}, ${item.ordinal})
      `;
    }
    for (const row of eligible) {
      await sql`
        insert into eligible_approvers (approval_id, workspace_id, user_id)
        values (${id}, ${auth.workspaceId}, ${row.user_id})
      `;
    }
    await queuePendingNotifications(sql, { workspaceId: auth.workspaceId, approvalId: id, action: input.action });
    await sql`
      insert into idempotency_keys (
        workspace_id, credential_id, operation, key, payload_hash, response, expires_at
      ) values (
        ${auth.workspaceId}, ${auth.agentId}, ${OPERATION}, ${key}, ${payloadHash},
        ${JSON.stringify({ id })}::jsonb, now() + interval '24 hours'
      )
    `;
    await audit({
      workspaceId: auth.workspaceId,
      actorType: "agent",
      actorId: auth.agentId,
      eventType: "approval.sealed",
      subjectType: "approval",
      subjectId: id,
      metadata: digests,
    }, sql);
    return id;
  });

  return await serializeApproval(auth.workspaceId, approvalId);
});
