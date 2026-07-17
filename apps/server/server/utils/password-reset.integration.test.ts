import { createId } from "@mayi/contracts";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import resetRequest from "../api/auth/password-reset/request.post";
import resetConfirm from "../api/auth/password-reset/confirm.post";
import { passwordHash, randomToken, tokenHash, verifyPassword } from "./crypto";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;

const rateLimit = vi.hoisted(() => ({ counts: new Map<string, number>(), enforce: false }));
vi.mock("./auth-rate-limit", async () => {
  const { createError } = await import("h3");
  return {
    authenticationClientAddress: () => "password-reset-integration-test",
    recordAuthenticationAttempt: async (identity: string, maximumPerHour: number) => {
      const attempts = (rateLimit.counts.get(identity) ?? 0) + 1;
      rateLimit.counts.set(identity, attempts);
      if (rateLimit.enforce && attempts > maximumPerHour) {
        throw createError({ statusCode: 429, statusMessage: "Too many authentication attempts; try again later" });
      }
      return identity;
    },
  };
});

const emailState = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; html: string }[] }));
vi.mock("./email-client", () => ({
  emailConfigured: () => true,
  sendEmail: async (options: { to: string; subject: string; html: string }) => { emailState.sent.push(options); },
}));
// Mocked so this suite does not depend on the @mayi/email package being built.
vi.mock("@mayi/email", () => ({
  renderPasswordResetEmail: async ({ resetUrl }: { resetUrl: string }) => `<a href="${resetUrl}">reset</a>`,
}));

const router = createRouter();
router.post("/api/auth/password-reset/request", resetRequest);
router.post("/api/auth/password-reset/confirm", resetConfirm);
const app = createApp();
app.use(router);
const handle = toWebHandler(app);

function post(path: "request" | "confirm", input: unknown): Promise<Response> {
  return handle(new Request(`http://mayi.test/api/auth/password-reset/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

const OLD_PASSWORD = "Old-password-1!";
const NEW_PASSWORD = "New-password-2!";
const userIds: string[] = [];

async function seedUser(): Promise<{ id: string; email: string }> {
  const id = createId();
  const email = `reset-${createId().toLowerCase()}@example.test`;
  await database().sql`
    insert into users (id, email, display_name, password_hash)
    values (${id}, ${email}, 'Reset test', ${await passwordHash(OLD_PASSWORD)})
  `;
  userIds.push(id);
  return { id, email };
}

function lastSentToken(): string {
  const html = emailState.sent.at(-1)!.html;
  const match = /\?reset=([^"]+)/.exec(html);
  expect(match).not.toBeNull();
  return match![1]!;
}

async function storedPasswordHash(userId: string): Promise<string> {
  const [row] = await database().sql`select password_hash from users where id = ${userId}`;
  return String(row!.password_hash);
}

describe.sequential("password reset", () => {
  beforeAll(async () => {
    // Self-sufficient when the migration adding this table has not landed yet;
    // the DDL mirrors the migration exactly.
    await database().sql.unsafe(`
      create table if not exists password_reset_tokens (
        id mayi_id primary key,
        user_id mayi_id not null references users(id) on delete cascade,
        token_hash text not null unique,
        expires_at timestamptz not null,
        created_at timestamptz default now() not null,
        used_at timestamptz
      )
    `);
  });

  afterAll(async () => {
    if (userIds.length) {
      await database().sql`delete from sessions where user_id in ${database().sql(userIds)}`;
      await database().sql`delete from users where id in ${database().sql(userIds)}`;
    }
    await database().close();
  });

  it("resets the password end to end and revokes active sessions", async () => {
    const user = await seedUser();
    const sessionId = createId();
    await database().sql`
      insert into sessions (id, user_id, token_hash, recent_auth_at, expires_at)
      values (${sessionId}, ${user.id}, ${await tokenHash(`mayi_session_${randomToken()}`)}, now(), now() + interval '30 days')
    `;

    const requested = await post("request", { email: user.email });
    expect(requested.status).toBe(202);
    await expect(requested.json()).resolves.toEqual({ ok: true });
    expect(emailState.sent.at(-1)).toMatchObject({ to: user.email, subject: "Reset your May I? password" });
    const token = lastSentToken();

    const confirmed = await post("confirm", { token, password: NEW_PASSWORD });
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toEqual({ ok: true });

    const hash = await storedPasswordHash(user.id);
    expect(await verifyPassword(OLD_PASSWORD, hash)).toBe(false);
    expect(await verifyPassword(NEW_PASSWORD, hash)).toBe(true);

    const [session] = await database().sql`select revoked_at from sessions where id = ${sessionId}`;
    expect(session!.revoked_at).not.toBeNull();
  });

  it("rejects reuse of a consumed token", async () => {
    const user = await seedUser();
    await post("request", { email: user.email });
    const token = lastSentToken();
    expect((await post("confirm", { token, password: NEW_PASSWORD })).status).toBe(200);

    const reused = await post("confirm", { token, password: "Another-pass-3!" });
    expect(reused.status).toBe(400);
    const [row] = await database().sql`select used_at from password_reset_tokens where token_hash = ${await tokenHash(token)}`;
    expect(row!.used_at).not.toBeNull();
    expect(await verifyPassword(NEW_PASSWORD, await storedPasswordHash(user.id))).toBe(true);
  });

  it("rejects an expired token", async () => {
    const user = await seedUser();
    const token = randomToken();
    await database().sql`
      insert into password_reset_tokens (id, user_id, token_hash, expires_at)
      values (${createId()}, ${user.id}, ${await tokenHash(token)}, now() - interval '1 minute')
    `;
    expect((await post("confirm", { token, password: NEW_PASSWORD })).status).toBe(400);
    expect(await verifyPassword(OLD_PASSWORD, await storedPasswordHash(user.id))).toBe(true);
  });

  it("returns 202 for an unknown email without minting a token or sending mail", async () => {
    const sentBefore = emailState.sent.length;
    const tokensBefore = await database().sql`select count(*)::int as count from password_reset_tokens`;
    const response = await post("request", { email: `nobody-${createId().toLowerCase()}@example.test` });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(emailState.sent.length).toBe(sentBefore);
    const tokensAfter = await database().sql`select count(*)::int as count from password_reset_tokens`;
    expect(Number(tokensAfter[0]!.count)).toBe(Number(tokensBefore[0]!.count));
  });

  it("invalidates the previous unused token when a new reset is requested", async () => {
    const user = await seedUser();
    await post("request", { email: user.email });
    const first = lastSentToken();
    await post("request", { email: user.email });
    const second = lastSentToken();
    expect(second).not.toBe(first);

    expect((await post("confirm", { token: first, password: NEW_PASSWORD })).status).toBe(400);
    expect((await post("confirm", { token: second, password: NEW_PASSWORD })).status).toBe(200);
    expect(await verifyPassword(NEW_PASSWORD, await storedPasswordHash(user.id))).toBe(true);
  });

  it("surfaces 429 when the rate limit is exceeded", async () => {
    rateLimit.enforce = true;
    rateLimit.counts.clear();
    try {
      // The per-source request limit is 10/hour; distinct emails keep the
      // per-account limit out of the way.
      const statuses: number[] = [];
      for (let index = 0; index < 11; index++) {
        const response = await post("request", { email: `throttle-${index}-${createId().toLowerCase()}@example.test` });
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 202));
      expect(statuses[10]).toBe(429);

      rateLimit.counts.clear();
      for (let index = 0; index < 10; index++) {
        await post("confirm", { token: `missing-${index}`, password: NEW_PASSWORD });
      }
      const throttled = await post("confirm", { token: "missing-final", password: NEW_PASSWORD });
      expect(throttled.status).toBe(429);
    } finally {
      rateLimit.enforce = false;
      rateLimit.counts.clear();
    }
  });

  it("rejects a weak password on confirm with 422", async () => {
    const user = await seedUser();
    await post("request", { email: user.email });
    const token = lastSentToken();
    const response = await post("confirm", { token, password: "short" });
    expect(response.status).toBe(422);
    // The token survives a validation failure and still works.
    expect((await post("confirm", { token, password: NEW_PASSWORD })).status).toBe(200);
  });
});
