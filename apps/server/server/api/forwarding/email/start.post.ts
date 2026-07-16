import { z } from "zod";
import { createId } from "@mayi/contracts";
import { renderForwardingVerificationEmail } from "@mayi/email";
import { createError, defineEventHandler } from "h3";
import { bodyAs } from "../../../utils/http";
import { requireUser } from "../../../utils/auth";
import { database } from "../../../utils/runtime";
import { randomToken, tokenHash } from "../../../utils/crypto";
import { emailConfigured, sendEmail } from "../../../utils/email-client";

const Input = z.object({ name: z.string().min(1).max(100), email: z.email() });
export default defineEventHandler(async (event) => {
  const auth = await requireUser(event); if (auth.role !== "OWNER") throw createError({ statusCode: 403, statusMessage: "Owner access required" }); const input = await bodyAs(event, Input);
  if (!emailConfigured()) throw createError({ statusCode: 503, statusMessage: "Email provider is not configured" });
  const code = randomToken(12); const id = createId(); const [row] = await database().sql`
    insert into forwarding_destinations (id, workspace_id, type, name, endpoint, mode, verification_hash, verification_expires_at)
    values (${id}, ${auth.workspaceId}, 'EMAIL', ${input.name}, ${input.email.toLowerCase()}, 'notify_only', ${await tokenHash(code)}, now() + interval '15 minutes') returning id
  `;
  const [workspace] = await database().sql`select name from workspaces where id = ${auth.workspaceId}`;
  try {
    const html = await renderForwardingVerificationEmail({ code, workspaceName: String(workspace!.name) });
    await sendEmail({ to: input.email.toLowerCase(), subject: "Verify your May I? forwarding address", html });
  } catch {
    await database().sql`delete from forwarding_destinations where id = ${row!.id}`;
    throw createError({ statusCode: 502, statusMessage: "Email provider rejected verification message" });
  }
  return { id: String(row!.id), pendingVerification: true };
});
