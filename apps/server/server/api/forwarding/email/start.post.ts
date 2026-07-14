import { z } from "zod";
import { createError, defineEventHandler } from "h3";
import { bodyAs } from "../../../utils/http";
import { requireUser } from "../../../utils/auth";
import { database } from "../../../utils/runtime";
import { randomToken, tokenHash } from "../../../utils/crypto";

const Input = z.object({ name: z.string().min(1).max(100), email: z.email() });
export default defineEventHandler(async (event) => {
  const auth = await requireUser(event); if (auth.role !== "OWNER") throw createError({ statusCode: 403, statusMessage: "Owner access required" }); const input = await bodyAs(event, Input);
  if (!process.env.EMAIL_API_URL || !process.env.EMAIL_API_KEY) throw createError({ statusCode: 503, statusMessage: "Email provider is not configured" });
  const code = randomToken(12); const [row] = await database().sql`
    insert into forwarding_destinations (workspace_id, type, name, endpoint, mode, verification_hash, verification_expires_at)
    values (${auth.workspaceId}, 'EMAIL', ${input.name}, ${input.email.toLowerCase()}, 'notify_only', ${await tokenHash(code)}, now() + interval '15 minutes') returning id
  `;
  const response = await fetch(process.env.EMAIL_API_URL, { method: "POST", headers: { authorization: `Bearer ${process.env.EMAIL_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ to: input.email, subject: "Verify your May I? forwarding address", text: `Verification code: ${code}` }) });
  if (!response.ok) { await database().sql`delete from forwarding_destinations where id = ${row!.id}`; throw createError({ statusCode: 502, statusMessage: "Email provider rejected verification message" }); }
  return { id: String(row!.id), pendingVerification: true };
});
