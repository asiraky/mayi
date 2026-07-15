import { createId } from "@mayi/contracts";
import { signReceipt, type ReceiptClaims } from "@mayi/receipts";
import { exportJWK, generateKeyPair } from "jose";
import { createApp, toWebHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import consumeReceipt from "../api/receipts/consume.post";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;
const issuer = "https://issuer.example";
const audience = "executor-under-test";
const consumerKey = `consumer-${createId()}`;
const ids = {
  user: createId(), workspace: createId(), agent: createId(), approval: createId(), receipt: createId(),
};
const actionDigest = "a".repeat(64);
const manifestDigest = "b".repeat(64);
let compactReceipt = "";
const previousEnvironment = {
  private: process.env.RECEIPT_PRIVATE_JWK,
  public: process.env.RECEIPT_PUBLIC_JWK,
  previous: process.env.RECEIPT_PREVIOUS_PUBLIC_JWKS,
  issuer: process.env.RECEIPT_ISSUER,
  consumers: process.env.CONSUMER_API_KEYS,
};

const app = createApp();
app.use("/api/receipts/consume", consumeReceipt);
const handle = toWebHandler(app);

function post(body: unknown, key = consumerKey): Promise<Response> {
  return handle(new Request("http://mayi.test/api/receipts/consume", {
    method: "POST",
    headers: { "content-type": "application/json", "x-consumer-key": key },
    body: JSON.stringify(body),
  }));
}

describe.sequential("POST /api/receipts/consume", () => {
  beforeAll(async () => {
    const oldPair = await generateKeyPair("EdDSA", { extractable: true });
    const newPair = await generateKeyPair("EdDSA", { extractable: true });
    const oldPrivate = { ...await exportJWK(oldPair.privateKey), kid: "receipt-old" };
    const oldPublic = { ...await exportJWK(oldPair.publicKey), kid: "receipt-old" };
    const newPrivate = { ...await exportJWK(newPair.privateKey), kid: "receipt-new" };
    const newPublic = { ...await exportJWK(newPair.publicKey), kid: "receipt-new" };
    process.env.RECEIPT_PRIVATE_JWK = JSON.stringify(newPrivate);
    process.env.RECEIPT_PUBLIC_JWK = JSON.stringify(newPublic);
    process.env.RECEIPT_PREVIOUS_PUBLIC_JWKS = JSON.stringify([oldPublic]);
    process.env.RECEIPT_ISSUER = issuer;
    process.env.CONSUMER_API_KEYS = JSON.stringify({ [audience]: consumerKey });
    delete (globalThis as typeof globalThis & { __mayiKeys?: unknown }).__mayiKeys;

    const now = Math.floor(Date.now() / 1_000);
    const claims: ReceiptClaims = {
      iss: issuer, aud: audience, sub: ids.approval, jti: ids.receipt, iat: now, exp: now + 900,
      workspace_id: ids.workspace, agent_id: ids.agent, approver_id: ids.user, policy_version: 1,
      action_digest: actionDigest, artefact_manifest_digest: manifestDigest, enforcement: "consumed",
    };
    compactReceipt = await signReceipt(claims, oldPrivate, "receipt-old");
    await database().sql`
      insert into users (id, email, display_name, password_hash)
      values (${ids.user}, ${`receipt-${ids.user}@example.com`}, 'Receipt approver', 'unused')
    `;
    await database().sql`insert into workspaces (id, name) values (${ids.workspace}, 'Receipt consumption')`;
    await database().sql`
      insert into agents (id, workspace_id, name, scopes, created_by)
      values (${ids.agent}, ${ids.workspace}, 'Receipt agent', ${[]}, ${ids.user})
    `;
    await database().sql`
      insert into approvals (
        id, workspace_id, agent_id, state, action, explanation, enforcement,
        action_digest, manifest_digest, policy_version, expires_at, sealed_at, decided_at, approver_id
      ) values (
        ${ids.approval}, ${ids.workspace}, ${ids.agent}, 'APPROVED',
        ${JSON.stringify({ kind: "tool-call", toolName: "execute", callId: createId(), input: {} })}::jsonb,
        'Consume rotated receipt', 'consumed', ${actionDigest}, ${manifestDigest}, 1,
        now() + interval '15 minutes', now(), now(), ${ids.user}
      )
    `;
    await database().sql`
      insert into receipts (id, approval_id, workspace_id, audience, compact_jws, expires_at)
      values (${ids.receipt}, ${ids.approval}, ${ids.workspace}, ${audience}, ${compactReceipt}, now() + interval '15 minutes')
    `;
  });

  afterAll(async () => {
    await database().sql`delete from workspaces where id = ${ids.workspace}`;
    await database().sql`delete from users where id = ${ids.user}`;
    await database().close();
    for (const [name, value] of Object.entries(previousEnvironment)) {
      const key = name === "private" ? "RECEIPT_PRIVATE_JWK"
        : name === "public" ? "RECEIPT_PUBLIC_JWK"
          : name === "previous" ? "RECEIPT_PREVIOUS_PUBLIC_JWKS"
            : name === "issuer" ? "RECEIPT_ISSUER" : "CONSUMER_API_KEYS";
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete (globalThis as typeof globalThis & { __mayiKeys?: unknown }).__mayiKeys;
  });

  it("accepts a retained key and serializes simultaneous consumption without a 500", async () => {
    const responses = await Promise.all([
      post({ receipt: compactReceipt, actionDigest, manifestDigest }),
      post({ receipt: compactReceipt, actionDigest, manifestDigest }),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const successful = responses.find(({ status }) => status === 200)!;
    await expect(successful.json()).resolves.toEqual({ consumed: true, receiptId: ids.receipt, requestId: ids.approval });
  });

  it("maps a malformed compact receipt to a client error", async () => {
    const response = await post({ receipt: "x".repeat(40), actionDigest, manifestDigest });
    expect(response.status).toBe(400);
  });

  it("rejects a chunked JSON body once it crosses 128 KiB", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(128 * 1024));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const response = await handle(new Request("http://mayi.test/api/receipts/consume", {
      method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half",
    } as RequestInit & { duplex: "half" }));
    expect(response.status).toBe(413);
  });
});
