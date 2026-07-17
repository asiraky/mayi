import { createId, PasswordResetRequest } from "@mayi/contracts";
import { renderPasswordResetEmail } from "@mayi/email";
import { defineEventHandler, setResponseStatus } from "h3";
import { bodyAs } from "../../../utils/http";
import { database } from "../../../utils/runtime";
import { getConfig } from "../../../utils/config";
import { randomToken, tokenHash } from "../../../utils/crypto";
import { authenticationClientAddress, recordAuthenticationAttempt } from "../../../utils/auth-rate-limit";
import { emailConfigured, sendEmail } from "../../../utils/email-client";

export default defineEventHandler(async (event) => {
  const input = await bodyAs(event, PasswordResetRequest);
  const email = input.email.toLowerCase();
  const source = authenticationClientAddress(event);
  await recordAuthenticationAttempt(`password-reset-request:${source}`, 10);
  await recordAuthenticationAttempt(`password-reset-account:${source}:${email}`, 5);
  // Whatever happens below, the response never changes: 202 either way, so a
  // caller cannot learn whether the address has an account.
  setResponseStatus(event, 202);
  // Bail before touching any rows if we can't deliver — otherwise we'd invalidate
  // the user's existing valid link with no replacement ever reaching them.
  if (!emailConfigured()) {
    console.warn("Password reset requested but email delivery is not configured");
    return { ok: true };
  }
  const users = await database().sql`
    select id from users where lower(email) = ${email} and active and deleted_at is null
  `;
  const user = users[0];
  if (!user) return { ok: true };
  const token = randomToken();
  const id = createId();
  await database().sql`
    insert into password_reset_tokens (id, user_id, token_hash, expires_at)
    values (${id}, ${user.id}, ${await tokenHash(token)}, now() + interval '30 minutes')
  `;
  try {
    const resetUrl = `${getConfig().publicOrigin}/?reset=${token}`;
    const html = await renderPasswordResetEmail({ resetUrl });
    await sendEmail({ to: email, subject: "Reset your May I? password", html });
  } catch {
    // A failed send must not reveal account existence, so clean up the unsent
    // token, leave any prior valid link intact, and stay 202.
    await database().sql`delete from password_reset_tokens where id = ${id}`;
    return { ok: true };
  }
  // Only once the new link is on its way do we invalidate older unused tokens,
  // so a send failure never strands the user without a working link.
  await database().sql`
    delete from password_reset_tokens where user_id = ${user.id} and used_at is null and id <> ${id}
  `;
  return { ok: true };
});
