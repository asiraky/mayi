import { InputAnswer, canonicalDigest, createId, type InputOption, type InputType } from "@mayi/contracts";
import { validateInputAnswer } from "@mayi/domain";
import { signAnswerAttestation } from "@mayi/receipts";
import { createError, defineEventHandler, getRouterParam } from "h3";
import { audit, requireUser } from "../../../utils/auth";
import { getConfig } from "../../../utils/config";
import { bodyAs, asHttpError } from "../../../utils/http";
import { database } from "../../../utils/runtime";
import { serializeInput } from "../../../utils/serialize";
import { signingKeys } from "../../../utils/signer";
import { activateInputCallback } from "../../../utils/callback-outbox";

export default defineEventHandler(async (event) => {
  const auth = await requireUser(event);
  const inputId = getRouterParam(event, "id")!;
  const answer = await bodyAs(event, InputAnswer);
  try {
    await database().sql.begin(async (sql) => {
      const [input] = await sql`
        select i.*, now() as database_now from inputs i
        where i.id = ${inputId} and i.workspace_id = ${auth.workspaceId} for update
      `;
      if (!input) throw createError({ statusCode: 404, statusMessage: "Input not found" });
      if (input.state !== "PENDING") throw createError({ statusCode: 409, statusMessage: `Input is ${String(input.state).toLowerCase()}` });
      const now = new Date(input.database_now as Date | string);
      const expiresAt = new Date(input.expires_at as Date | string);
      if (expiresAt.getTime() <= now.getTime()) {
        await sql`update inputs set state = 'EXPIRED' where id = ${inputId} and state = 'PENDING'`;
        await activateInputCallback(sql, inputId);
        await audit({ workspaceId: auth.workspaceId, actorType: "system", eventType: "input.expired", subjectType: "input", subjectId: inputId }, sql);
        return;
      }
      const eligible = await sql`
        select 1 from input_eligible_respondents e
        join memberships m on m.workspace_id = e.workspace_id and m.user_id = e.user_id and m.active and m.revoked_at is null
        join users u on u.id = e.user_id and u.active and u.deleted_at is null
        where e.input_id = ${inputId} and e.workspace_id = ${auth.workspaceId} and e.user_id = ${auth.userId}
      `;
      if (!eligible.length) throw createError({ statusCode: 403, statusMessage: "You are not currently eligible to answer this request" });
      validateInputAnswer({
        type: input.type as InputType,
        options: input.options as InputOption[] | null,
        allowFreeform: Boolean(input.allow_freeform),
      }, answer);
      const keys = await signingKeys();
      const attestation = await signAnswerAttestation({
        iss: getConfig().receiptIssuer, sub: inputId, jti: createId(),
        iat: Math.floor(now.getTime() / 1000),
        workspace_id: auth.workspaceId, agent_id: String(input.agent_id),
        input_type: input.type as InputType,
        prompt_digest: await canonicalDigest({ prompt: String(input.prompt) }),
        answer, answer_digest: await canonicalDigest(answer),
        respondent_id: auth.userId, answered_at: now.toISOString(),
      }, keys.privateJwk, keys.kid);
      await sql`
        update inputs set state = 'ANSWERED', answer = ${JSON.stringify(answer)}::jsonb,
          attestation = ${attestation}, respondent_id = ${auth.userId}, answered_at = now()
        where id = ${inputId} and state = 'PENDING'
      `;
      await activateInputCallback(sql, inputId);
      await audit({ workspaceId: auth.workspaceId, actorType: "user", actorId: auth.userId, eventType: "input.answered", subjectType: "input", subjectId: inputId }, sql);
    });
  } catch (error) { asHttpError(error); }
  return await serializeInput(auth.workspaceId, inputId);
});
