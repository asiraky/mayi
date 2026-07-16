import { PasswordResetConfirm } from "@mayi/contracts";
import { createError, defineEventHandler } from "h3";
import { bodyAs } from "../../../utils/http";
import { database } from "../../../utils/runtime";
import { passwordHash, tokenHash } from "../../../utils/crypto";
import { authenticationClientAddress, recordAuthenticationAttempt } from "../../../utils/auth-rate-limit";

const invalidToken = () => createError({ statusCode: 400, statusMessage: "Reset link is invalid or has expired" });

export default defineEventHandler(async (event) => {
  const input = await bodyAs(event, PasswordResetConfirm);
  const source = authenticationClientAddress(event);
  await recordAuthenticationAttempt(`password-reset-confirm:${source}`, 10);
  const rows = await database().sql`
    select t.id, t.user_id, t.used_at, t.expires_at <= now() as expired
    from password_reset_tokens t
    join users u on u.id = t.user_id and u.active and u.deleted_at is null
    where t.token_hash = ${await tokenHash(input.token)}
  `;
  const row = rows[0];
  // One message for missing, used, and expired: the lookup is by hash, so timing
  // reveals nothing and the caller cannot distinguish the failure modes.
  if (!row || row.used_at !== null || row.expired) throw invalidToken();
  const hash = await passwordHash(input.password);
  await database().sql.begin(async (sql) => {
    const used = await sql`
      update password_reset_tokens set used_at = now() where id = ${row.id} and used_at is null returning id
    `;
    if (!used.length) throw invalidToken();
    await sql`update users set password_hash = ${hash} where id = ${row.user_id}`;
    await sql`update sessions set revoked_at = now() where user_id = ${row.user_id} and revoked_at is null`;
  });
  return { ok: true };
});
