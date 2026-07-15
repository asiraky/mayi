import { createApp, createRouter, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import registerClient, {
  OAUTH_REGISTRATION_LIMITS,
  assertRegistrationAttemptAllowed,
  recordRegistrationAttempt,
} from "../api/oauth/register.post";
import { tokenHash } from "./crypto";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;

const addresses = {
  parallel: "203.0.113.41",
  invalidBody: "203.0.113.42",
  stale: "203.0.113.43",
  current: "203.0.113.44",
};
const hashes = await Promise.all(Object.values(addresses).map((address) => tokenHash(address)));

const router = createRouter();
router.post("/api/oauth/register", registerClient);
const app = createApp();
app.use(router);
const handle = toWebHandler(app);

describe.sequential("OAuth registration attempt limiting", () => {
  const previousTrustedHeader = process.env.OAUTH_REGISTRATION_TRUSTED_IP_HEADER;

  beforeAll(async () => {
    process.env.OAUTH_REGISTRATION_TRUSTED_IP_HEADER = "x-test-client-ip";
    await database().sql`delete from oauth_registration_attempts where identity_hash in ${database().sql(hashes)}`;
  });

  afterAll(async () => {
    await database().sql`delete from oauth_registration_attempts where identity_hash in ${database().sql(hashes)}`;
    if (previousTrustedHeader === undefined) delete process.env.OAUTH_REGISTRATION_TRUSTED_IP_HEADER;
    else process.env.OAUTH_REGISTRATION_TRUSTED_IP_HEADER = previousTrustedHeader;
    await database().close();
  });

  it("atomically fences parallel attempts across database clients", async () => {
    const hash = await tokenHash(addresses.parallel);
    const attempts = await Promise.all(Array.from(
      { length: OAUTH_REGISTRATION_LIMITS.attemptsPerIpPerHour + 10 },
      () => recordRegistrationAttempt(hash),
    ));

    expect(attempts.filter((attempt) => attempt <= OAUTH_REGISTRATION_LIMITS.attemptsPerIpPerHour))
      .toHaveLength(OAUTH_REGISTRATION_LIMITS.attemptsPerIpPerHour);
    expect(attempts.filter((attempt) => attempt > OAUTH_REGISTRATION_LIMITS.attemptsPerIpPerHour))
      .toHaveLength(10);
    expect(() => assertRegistrationAttemptAllowed(Math.max(...attempts))).toThrow(/attempt limit/);
    const [stored] = await database().sql`
      select attempts from oauth_registration_attempts where identity_hash = ${hash}
    `;
    expect(Number(stored!.attempts)).toBe(OAUTH_REGISTRATION_LIMITS.attemptsPerIpPerHour + 1);
  });

  it("charges malformed JSON before parsing", async () => {
    const requests = Array.from(
      { length: OAUTH_REGISTRATION_LIMITS.attemptsPerIpPerHour + 1 },
      () => handle(new Request("http://mayi.test/api/oauth/register", {
        method: "POST",
        headers: { "x-test-client-ip": addresses.invalidBody },
        body: "{",
      })),
    );
    const responses = [];
    for (const request of requests) responses.push(await request);
    expect(responses.filter((response) => response.status === 400))
      .toHaveLength(OAUTH_REGISTRATION_LIMITS.attemptsPerIpPerHour);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
  });

  it("resets an expired window and prunes stale identities", async () => {
    const staleHash = await tokenHash(addresses.stale);
    const currentHash = await tokenHash(addresses.current);
    await database().sql`
      insert into oauth_registration_attempts (identity_hash, window_started_at, attempts, last_attempt_at)
      values (${staleHash}, now() - interval '25 hours', 31, now() - interval '25 hours')
    `;
    await database().sql`
      insert into oauth_registration_attempts (identity_hash, window_started_at, attempts, last_attempt_at)
      values (${currentHash}, now() - interval '61 minutes', 31, now())
    `;

    await expect(recordRegistrationAttempt(currentHash)).resolves.toBe(1);
    const stale = await database().sql`
      select 1 from oauth_registration_attempts where identity_hash = ${staleHash}
    `;
    expect(stale).toHaveLength(0);
  });
});
