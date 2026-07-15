import { canonicalize, createId } from "@mayi/contracts";
import { createWebhookVerifier } from "@mayi/sdk/webhook-verifier";
import { generateKeyPair, exportJWK } from "jose";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import jwksHandler from "../routes/.well-known/jwks.json.get";
import {
  CALLBACK_JOB_TYPE,
  CallbackDeliveryError,
  activateApprovalCallback,
  callbackRetryDelaySeconds,
  claimNextJob,
  deliverCallbackHttpNode,
  markCallbackDelivered,
  markCallbackFailed,
  sendApprovalCallback,
  type OutboxJob,
  type NodeHttpsRequest,
} from "./callback-outbox";
import type { ValidatedPublicUrl } from "./public-url";
import { signWebhook } from "./forwarding";
import { database } from "./runtime";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://mayi:mayi@localhost:55432/mayi";
process.env.DATABASE_URL = DATABASE_URL;

const ids = { user: createId(), workspace: createId(), agent: createId() };
const opaqueState = "sealed.v1/Ω+ciphertext_ß_🔒/\"exact\"";

async function createReadyCallback(status: "APPROVED" | "DENIED" | "EXPIRED" = "DENIED"): Promise<{ callbackId: string; jobId: string; receipt?: string }> {
  const approvalId = createId();
  const callbackId = createId();
  const receipt = status === "APPROVED" ? `approved-receipt-${createId()}` : undefined;
  await database().sql.begin(async (sql) => {
    await sql`
      insert into approvals (
        id, workspace_id, agent_id, state, action, explanation, enforcement,
        action_digest, manifest_digest, policy_version, expires_at, sealed_at, decided_at, approver_id
      ) values (
        ${approvalId}, ${ids.workspace}, ${ids.agent}, ${status},
        ${JSON.stringify({ kind: "tool-call", toolName: "deploy", callId: createId(), input: {} })}::jsonb,
        'Delivery integration', 'cooperative', ${"d".repeat(64)}, ${"e".repeat(64)}, 1,
        now() + interval '1 hour', now(), now(), ${status === "DENIED" || status === "APPROVED" ? ids.user : null}
      )
    `;
    await sql`
      insert into approval_callbacks (id, approval_id, workspace_id, url, state)
      values (${callbackId}, ${approvalId}, ${ids.workspace}, 'https://callback.example/resolve', ${opaqueState})
    `;
    if (receipt) {
      await sql`
        insert into receipts (id, approval_id, workspace_id, audience, compact_jws, expires_at)
        values (${createId()}, ${approvalId}, ${ids.workspace}, 'test-executor', ${receipt}, now() + interval '15 minutes')
      `;
    }
    await activateApprovalCallback(sql, approvalId);
  });
  const [job] = await database().sql`
    select id from jobs where type = ${CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId}
  `;
  return { callbackId, jobId: String(job!.id), ...(receipt ? { receipt } : {}) };
}

async function claim(jobId: string): Promise<OutboxJob> {
  const job = await claimNextJob(database().sql, { jobId });
  if (!job) throw new Error("Expected callback job to be claimable");
  return job;
}

function target(value = "https://callback.example/resolve", pinnedAddress = "8.8.8.8"): ValidatedPublicUrl {
  return { url: new URL(value), addresses: [pinnedAddress], pinnedAddress, redirect: "error" };
}

function requestResponse(
  status: number,
  inspect?: (options: RequestOptions) => void,
  headers: Record<string, string> = {},
): { request: NodeHttpsRequest; calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const request: NodeHttpsRequest = (options, callback) => {
    calls.push(options);
    inspect?.(options);
    const req = new EventEmitter() as ClientRequest;
    req.destroy = vi.fn(() => req);
    req.end = vi.fn(() => {
      const socket = Object.assign(new EventEmitter(), {
        encrypted: true, connecting: true, secureConnecting: true,
      });
      req.emit("socket", socket);
      socket.connecting = false;
      socket.secureConnecting = false;
      socket.emit("secureConnect");
      const stream = new PassThrough();
      const response = stream as unknown as IncomingMessage;
      response.statusCode = status;
      response.headers = headers;
      response.setTimeout = vi.fn(() => response);
      callback(response);
      stream.end();
      return req;
    }) as ClientRequest["end"];
    return req;
  };
  return { request, calls };
}

beforeAll(async () => {
  await database().sql`
    insert into users (id, email, display_name, password_hash)
    values (${ids.user}, ${`callback-delivery-${ids.user}@example.com`}, 'Delivery Approver', 'unused')
  `;
  await database().sql`insert into workspaces (id, name) values (${ids.workspace}, 'Callback delivery integration')`;
  await database().sql`
    insert into agents (id, workspace_id, name, scopes, created_by)
    values (${ids.agent}, ${ids.workspace}, 'Delivery agent', ${[]}, ${ids.user})
  `;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete (globalThis as typeof globalThis & { __mayiKeys?: unknown }).__mayiKeys;
});

afterAll(async () => {
  await database().sql`delete from workspaces where id = ${ids.workspace}`;
  await database().sql`delete from users where id = ${ids.user}`;
  await database().close();
});

describe.sequential("terminal callback delivery", () => {
  it("uses the documented 50%-150% exponential jitter bounds", () => {
    expect(callbackRetryDelaySeconds(1, () => 0)).toBe(2.5);
    expect(callbackRetryDelaySeconds(1, () => 1)).toBe(7.5);
    expect(callbackRetryDelaySeconds(9, () => 1)).toBe(1_920);
  });

  it("enforces the pre-connect timeout in the production Node transport", async () => {
    vi.useFakeTimers();
    try {
      const request: NodeHttpsRequest = () => {
        const req = new EventEmitter() as ClientRequest;
        req.destroy = vi.fn(() => req);
        req.end = vi.fn(() => req) as ClientRequest["end"];
        return req;
      };
      const delivery = deliverCallbackHttpNode(target(), "{}", "signature", {
        request, isIP: () => 0, connectTimeoutMs: 25, totalTimeoutMs: 100,
      });
      const assertion = expect(delivery).rejects.toMatchObject({ code: "connect_timeout", retryable: true });
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("connects to the pinned address while preserving Host and normalized TLS SNI", async () => {
    const hostname = requestResponse(204);
    await expect(deliverCallbackHttpNode(target(), "{}", "signature", {
      request: hostname.request, isIP: () => 0,
    })).resolves.toMatchObject({ status: 204 });
    expect(hostname.calls).toHaveLength(1);
    expect(hostname.calls[0]).toMatchObject({
      hostname: "8.8.8.8", servername: "callback.example",
      headers: { host: "callback.example" },
    });

    const ipv6 = requestResponse(204);
    const ipv6Address = "2606:4700:4700::1111";
    await expect(deliverCallbackHttpNode(target(`https://[${ipv6Address}]/resolve`, ipv6Address), "{}", "signature", {
      request: ipv6.request, isIP: (value) => value === ipv6Address ? 6 : 0,
    })).resolves.toMatchObject({ status: 204 });
    expect(ipv6.calls[0]).toMatchObject({
      hostname: ipv6Address, servername: undefined,
      headers: { host: `[${ipv6Address}]` },
    });
  });

  it("refuses a real Node transport redirect without requesting its Location", async () => {
    const { callbackId, jobId } = await createReadyCallback();
    const job = await claim(jobId);
    const redirect = requestResponse(302, undefined, { location: "https://127.0.0.1/internal" });
    await expect(sendApprovalCallback(job, {
      resolve: async () => ["8.8.8.8"],
      transport: (validated, body, signature) => deliverCallbackHttpNode(validated, body, signature, {
        request: redirect.request, isIP: () => 0,
      }),
    })).rejects.toMatchObject({ code: "redirect_refused", retryable: false });
    expect(redirect.calls).toHaveLength(1);
    expect(redirect.calls[0]).toMatchObject({ hostname: "8.8.8.8", path: "/resolve" });
    const [callback] = await database().sql`select delivery_status from approval_callbacks where id = ${callbackId}`;
    expect(callback!.delivery_status).toBe("RUNNING");
  });

  it("retries transient 5xx with jitter and the same stable event ID", async () => {
    const { callbackId, jobId } = await createReadyCallback();
    const bodies: string[] = [];
    const first = await claim(jobId);
    let error: unknown;
    try {
      await sendApprovalCallback(first, {
        resolve: async () => ["8.8.8.8"],
        transport: async (_target, body) => { bodies.push(body); return { status: 503, bytes: 0 }; },
      });
    } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "http_503", retryable: true });
    expect(await markCallbackFailed(first, error, { random: () => 0 })).toBe("retry");
    const [failed] = await database().sql`
      select delivery_status, attempts,
        extract(epoch from (next_attempt_at - now()))::float as callback_delay
      from approval_callbacks where id = ${callbackId}
    `;
    const [failedJob] = await database().sql`
      select extract(epoch from (available_at - now()))::float as job_delay from jobs where id = ${jobId}
    `;
    expect(failed).toMatchObject({ delivery_status: "FAILED", attempts: 1 });
    expect(Number(failed!.callback_delay)).toBeGreaterThan(2);
    expect(Number(failed!.callback_delay)).toBeLessThanOrEqual(2.5);
    expect(Math.abs(Number(failed!.callback_delay) - Number(failedJob!.job_delay))).toBeLessThan(0.1);
    await database().sql`update jobs set available_at = now() where id = ${jobId}`;
    await database().sql`update approval_callbacks set next_attempt_at = now() where id = ${callbackId}`;
    const second = await claim(jobId);
    const delivered = await sendApprovalCallback(second, {
      resolve: async () => ["8.8.8.8"],
      transport: async (_target, body) => { bodies.push(body); return { status: 202, bytes: 0 }; },
    });
    await markCallbackDelivered(second);
    expect(second.attempts).toBe(2);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(delivered.event.id).toBe(callbackId);
  });

  it("does not retry permanent 4xx or redirects", async () => {
    for (const status of [400, 302]) {
      const { callbackId, jobId } = await createReadyCallback();
      const job = await claim(jobId);
      let error: unknown;
      try {
        await sendApprovalCallback(job, {
          resolve: async () => ["1.1.1.1"],
          transport: async () => ({ status, bytes: 0 }),
        });
      } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(CallbackDeliveryError);
      expect(error).toMatchObject({ retryable: false, code: status === 302 ? "redirect_refused" : "http_400" });
      expect(await markCallbackFailed(job, error)).toBe("dead_letter");
      const [callback] = await database().sql`select delivery_status, next_attempt_at from approval_callbacks where id = ${callbackId}`;
      expect(callback).toMatchObject({ delivery_status: "DEAD_LETTER", next_attempt_at: null });
    }
  });

  it("treats duplicate receiver acknowledgement as successful", async () => {
    const { callbackId, jobId } = await createReadyCallback("EXPIRED");
    const job = await claim(jobId);
    await expect(sendApprovalCallback(job, {
      resolve: async () => ["8.8.4.4"],
      transport: async () => ({ status: 208, bytes: 0 }),
    })).resolves.toMatchObject({ status: 208, event: { id: callbackId } });
    await markCallbackDelivered(job);
    const [callback] = await database().sql`select delivery_status, completed_at from approval_callbacks where id = ${callbackId}`;
    expect(callback!.delivery_status).toBe("DELIVERED");
    expect(callback!.completed_at).not.toBeNull();
  });

  it("rejects DNS rebinding and pins the selected delivery address", async () => {
    const rebound = await createReadyCallback();
    const reboundJob = await claim(rebound.jobId);
    await expect(sendApprovalCallback(reboundJob, {
      resolve: async () => ["127.0.0.1"],
      transport: async () => { throw new Error("must not connect"); },
    })).rejects.toMatchObject({ code: "url_non_public_address", retryable: false });

    const pinned = await createReadyCallback();
    const pinnedJob = await claim(pinned.jobId);
    await expect(sendApprovalCallback(pinnedJob, {
      resolve: async () => ["8.8.8.8", "1.1.1.1"],
      transport: async (target) => {
        expect(target.addresses).toEqual(["8.8.8.8", "1.1.1.1"]);
        expect(target.pinnedAddress).toBe("8.8.8.8");
        expect(target.redirect).toBe("error");
        return { status: 204, bytes: 0 };
      },
    })).resolves.toMatchObject({ status: 204 });
  });

  it("emits canonical bytes accepted by the actual SDK verifier without logging secrets", async () => {
    const { callbackId, jobId, receipt } = await createReadyCallback("APPROVED");
    const job = await claim(jobId);
    const consoleSpies = (["debug", "error", "info", "log", "warn"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined));
    let capturedBody = "";
    let capturedSignature = "";
    const delivered = await sendApprovalCallback(job, {
      resolve: async () => ["8.8.8.8"],
      transport: async (_target, body, signature) => {
        capturedBody = body;
        capturedSignature = signature;
        return { status: 200, bytes: 0 };
      },
    });
    expect(capturedBody).toBe(canonicalize(delivered.event));
    expect(JSON.parse(capturedBody)).toMatchObject({ id: callbackId, state: opaqueState, receipt });
    const verifier = createWebhookVerifier({
      mayiOrigin: "http://localhost:3000",
      maximumEventAgeSeconds: 3600,
      dangerouslyAllowInsecureHttpForTests: true,
      fetch: async () => new Response(JSON.stringify(await jwksHandler({} as never)), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    });
    await expect(verifier.verify({ body: capturedBody, signature: capturedSignature }))
      .resolves.toMatchObject({ duplicate: false, event: { id: callbackId, state: opaqueState, receipt } });
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    await markCallbackFailed(job, new Error(`${opaqueState}:${receipt}`), { random: () => 0 });
    const [genericJob] = await database().sql`select payload, last_error from jobs where id = ${jobId}`;
    const [callback] = await database().sql`select last_error from approval_callbacks where id = ${callbackId}`;
    const audits = await database().sql`select metadata from audit_events where subject_id = ${delivered.event.approvalId}`;
    expect(genericJob!.last_error).toBe("delivery_error");
    expect(callback!.last_error).toBe("delivery_error");
    expect(JSON.stringify([genericJob, callback, ...audits])).not.toContain(opaqueState);
    expect(JSON.stringify([genericJob, callback, ...audits])).not.toContain(receipt!);
  });

  it("lets the SDK verifier refresh from an old key to a new key during JWKS overlap", async () => {
    const oldPair = await generateKeyPair("EdDSA", { extractable: true });
    const newPair = await generateKeyPair("EdDSA", { extractable: true });
    const oldPrivate = { ...await exportJWK(oldPair.privateKey), kid: "rotation-old" };
    const oldPublic = { ...await exportJWK(oldPair.publicKey), kid: "rotation-old" };
    const newPrivate = { ...await exportJWK(newPair.privateKey), kid: "rotation-new" };
    const newPublic = { ...await exportJWK(newPair.publicKey), kid: "rotation-new" };
    let published = { keys: [{ ...oldPublic, use: "sig", alg: "EdDSA" }] };
    const verifier = createWebhookVerifier({
      mayiOrigin: "http://localhost:3000", maximumEventAgeSeconds: 3600,
      dangerouslyAllowInsecureHttpForTests: true,
      fetch: async () => new Response(JSON.stringify(published), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    });
    const event = {
      id: createId(), type: "approval.resolved" as const, version: 1 as const,
      approvalId: createId(), status: "expired" as const, state: opaqueState,
      occurredAt: new Date().toISOString(),
    };
    vi.stubEnv("RECEIPT_PRIVATE_JWK", JSON.stringify(oldPrivate));
    vi.stubEnv("RECEIPT_PUBLIC_JWK", JSON.stringify(oldPublic));
    delete (globalThis as typeof globalThis & { __mayiKeys?: unknown }).__mayiKeys;
    await expect(verifier.verify({ body: canonicalize(event), signature: await signWebhook(event) }))
      .resolves.toMatchObject({ duplicate: false, event: { id: event.id } });
    vi.stubEnv("RECEIPT_PRIVATE_JWK", JSON.stringify(newPrivate));
    vi.stubEnv("RECEIPT_PUBLIC_JWK", JSON.stringify(newPublic));
    vi.stubEnv("RECEIPT_PREVIOUS_PUBLIC_JWKS", JSON.stringify([oldPublic]));
    delete (globalThis as typeof globalThis & { __mayiKeys?: unknown }).__mayiKeys;
    published = { keys: [
      { ...newPublic, use: "sig", alg: "EdDSA" },
      { ...oldPublic, use: "sig", alg: "EdDSA" },
    ] };
    await expect(verifier.verify({ body: canonicalize(event), signature: await signWebhook(event) }))
      .resolves.toMatchObject({ duplicate: false, event: { id: event.id } });
  });
});
