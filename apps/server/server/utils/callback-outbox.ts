import { ApprovalResolvedEvent, canonicalize, createId, type ApprovalResolvedEvent as ApprovalResolvedEventType } from "@mayi/contracts";
import type { DatabaseSql } from "@mayi/db";
import type { Sql } from "postgres";
import { PublicUrlValidationError, validatePublicHttpsUrl, type PublicUrlResolver, type ValidatedPublicUrl } from "./public-url";
import { signWebhook } from "./forwarding";
import { database } from "./runtime";

export const CALLBACK_JOB_TYPE = "callback.approval_resolved";
export const CALLBACK_MAX_ATTEMPTS = 10;
export const CALLBACK_LEASE_SECONDS = 5 * 60;
export const CALLBACK_CONNECT_TIMEOUT_MS = 3_000;
export const CALLBACK_RESPONSE_TIMEOUT_MS = 5_000;
export const CALLBACK_TOTAL_TIMEOUT_MS = 10_000;
export const CALLBACK_MAX_RESPONSE_BYTES = 64 * 1024;
export const CALLBACK_RETRY_BASE_SECONDS = 5;
export const CALLBACK_MAX_RETRY_WINDOW_SECONDS = 3_832.5;

export type OutboxJob = {
  id: string;
  workspace_id: string;
  type: string;
  payload: { approvalId?: string; destinationId?: string; deliveryId?: string; callbackId?: string };
  attempts: number;
};

type CallbackRow = {
  id: string;
  approval_id: string;
  workspace_id: string;
  url: string;
  state: string;
  delivery_status: string;
  occurred_at: Date | string;
  approval_state: string;
  approver_id: string | null;
  compact_jws: string | null;
};

export type CallbackHttpResponse = { status: number; bytes: number };
export type CallbackTransport = (
  target: ValidatedPublicUrl,
  body: string,
  signature: string,
) => Promise<CallbackHttpResponse>;

export type CallbackDeliveryDependencies = {
  sql?: DatabaseSql;
  resolve?: PublicUrlResolver;
  transport?: CallbackTransport;
  random?: () => number;
  sign?: (payload: unknown) => Promise<string>;
};

type CallbackMutationDependencies = {
  sql?: Sql;
  random?: () => number;
};

export class CallbackDeliveryError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.name = "CallbackDeliveryError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Activates the existing per-approval callback and queues its only generic job.
 * This must be called with the transaction that commits the terminal approval.
 */
export async function activateApprovalCallback(sql: DatabaseSql, approvalId: string): Promise<string | undefined> {
  const rows = await sql`
    update approval_callbacks c
    set delivery_status = 'READY', occurred_at = a.decided_at,
      next_attempt_at = a.decided_at, attempts = 0, last_error = null,
      lease_expires_at = null, completed_at = null, dead_lettered_at = null
    from approvals a
    where c.approval_id = a.id and a.id = ${approvalId}
      and a.state in ('APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED')
      and a.decided_at is not null and c.delivery_status = 'WAITING'
    returning c.id, c.workspace_id
  `;
  const callback = rows[0];
  if (!callback) return undefined;
  const callbackId = String(callback.id);
  await sql`
    insert into jobs (id, workspace_id, type, dedupe_key, payload)
    values (
      ${createId()}, ${String(callback.workspace_id)}, ${CALLBACK_JOB_TYPE}, ${callbackId},
      ${JSON.stringify({ callbackId })}::jsonb
    )
    on conflict (type, dedupe_key) do nothing
  `;
  return callbackId;
}

export async function claimNextJob(
  sql: Sql = database().sql,
  options: { jobId?: string } = {},
): Promise<OutboxJob | undefined> {
  return sql.begin(async (tx) => {
    // A crash during the final allowed attempt must not leave RUNNING forever.
    // Its stable event can still be manually replayed from the dead letter state.
    await tx`
      update approval_callbacks c set delivery_status = 'DEAD_LETTER',
        lease_expires_at = null, next_attempt_at = null, last_error = 'lease_exhausted',
        dead_lettered_at = now()
      from jobs j
      where j.type = ${CALLBACK_JOB_TYPE} and j.dedupe_key = c.id
        and j.state = 'RUNNING' and j.attempts >= ${CALLBACK_MAX_ATTEMPTS}
        and coalesce(j.locked_at, '-infinity'::timestamptz) <= now() - make_interval(secs => ${CALLBACK_LEASE_SECONDS})
        and c.delivery_status = 'RUNNING'
    `;
    await tx`
      update jobs set state = 'DEAD_LETTER', locked_at = null,
        completed_at = now(), last_error = 'lease_exhausted'
      where state = 'RUNNING' and attempts >= ${CALLBACK_MAX_ATTEMPTS}
        and coalesce(locked_at, '-infinity'::timestamptz) <= now() - make_interval(secs => ${CALLBACK_LEASE_SECONDS})
    `;
    const rows = await tx`
      select id, workspace_id, type, payload, attempts from jobs
      where (${options.jobId ?? null}::mayi_id is null or id = ${options.jobId ?? null}::mayi_id)
        and attempts < ${CALLBACK_MAX_ATTEMPTS} and (
        (state in ('READY', 'FAILED') and available_at <= now())
        or (state = 'RUNNING' and coalesce(locked_at, '-infinity'::timestamptz) <= now() - make_interval(secs => ${CALLBACK_LEASE_SECONDS}))
      )
      order by available_at, created_at for update skip locked limit 1
    `;
    if (!rows[0]) return undefined;
    const claimed = await tx`
      update jobs set state = 'RUNNING', locked_at = now(), attempts = attempts + 1
      where id = ${rows[0].id}
      returning id, workspace_id, type, payload, attempts
    `;
    const job = claimed[0] as OutboxJob;
    if (job.type === CALLBACK_JOB_TYPE) {
      const callbackId = job.payload.callbackId;
      if (!callbackId) throw new Error("Callback job payload is invalid");
      const updated = await tx`
        update approval_callbacks
        set delivery_status = 'RUNNING', attempts = ${job.attempts},
          next_attempt_at = null,
          lease_expires_at = now() + make_interval(secs => ${CALLBACK_LEASE_SECONDS})
        where id = ${callbackId} and workspace_id = ${job.workspace_id}
          and delivery_status in ('READY', 'FAILED', 'RUNNING')
        returning id
      `;
      if (!updated[0]) throw new Error("Callback job has no deliverable callback");
    }
    return job;
  });
}

async function loadCallback(sql: DatabaseSql, job: OutboxJob): Promise<CallbackRow> {
  const callbackId = job.payload.callbackId;
  if (!callbackId) throw new CallbackDeliveryError("invalid_job", false);
  const rows = await sql`
    select c.id, c.approval_id, c.workspace_id, c.url, c.state, c.delivery_status,
      c.occurred_at, a.state as approval_state, a.approver_id, r.compact_jws
    from approval_callbacks c
    join approvals a on a.id = c.approval_id and a.workspace_id = c.workspace_id
    left join receipts r on r.approval_id = a.id and r.workspace_id = a.workspace_id
    where c.id = ${callbackId} and c.workspace_id = ${job.workspace_id}
  `;
  if (!rows[0]) throw new CallbackDeliveryError("callback_missing", false);
  return rows[0] as CallbackRow;
}

export function callbackEvent(row: CallbackRow): ApprovalResolvedEventType {
  const status = row.approval_state.toLowerCase();
  const event = {
    id: row.id,
    type: "approval.resolved",
    version: 1,
    approvalId: row.approval_id,
    status,
    state: row.state,
    occurredAt: new Date(row.occurred_at).toISOString(),
    ...((status === "approved" || status === "denied") && row.approver_id
      ? { approver: { id: row.approver_id } }
      : {}),
    ...(status === "approved" && row.compact_jws ? { receipt: row.compact_jws } : {}),
  };
  try {
    return ApprovalResolvedEvent.parse(event);
  } catch {
    throw new CallbackDeliveryError("invalid_event", false);
  }
}

function nodeRuntime(): boolean {
  return typeof process !== "undefined" && Boolean(process.versions?.node);
}

async function readFetchResponse(response: Response): Promise<number> {
  if (!response.body) return 0;
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return bytes;
      bytes += chunk.value.byteLength;
      if (bytes > CALLBACK_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CallbackDeliveryError("response_too_large", false);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function edgeTransport(target: ValidatedPublicUrl, body: string, signature: string): Promise<CallbackHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALLBACK_TOTAL_TIMEOUT_MS);
  try {
    const response = await fetch(target.url, {
      method: "POST",
      redirect: target.redirect,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-mayi-signature": signature,
        "user-agent": "MayI-Callback/1",
      },
      body,
    });
    return { status: response.status, bytes: await readFetchResponse(response) };
  } catch (error) {
    if (error instanceof CallbackDeliveryError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new CallbackDeliveryError("timeout", true);
    }
    throw new CallbackDeliveryError("network_error", true);
  } finally {
    clearTimeout(timer);
  }
}

async function nodePinnedTransport(target: ValidatedPublicUrl, body: string, signature: string): Promise<CallbackHttpResponse> {
  const { request } = await import("node:https");
  const { isIP } = await import("node:net");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: CallbackDeliveryError, response?: CallbackHttpResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      if (error) reject(error); else resolve(response!);
    };
    const totalTimer = setTimeout(() => {
      req.destroy();
      finish(new CallbackDeliveryError("timeout", true));
    }, CALLBACK_TOTAL_TIMEOUT_MS);
    const req = request({
      protocol: "https:",
      hostname: target.pinnedAddress,
      port: 443,
      method: "POST",
      path: `${target.url.pathname}${target.url.search}`,
      servername: isIP(target.url.hostname) ? undefined : target.url.hostname,
      headers: {
        host: target.url.host,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-mayi-signature": signature,
        "user-agent": "MayI-Callback/1",
      },
    }, (response) => {
      response.setTimeout(CALLBACK_RESPONSE_TIMEOUT_MS, () => {
        response.destroy();
        finish(new CallbackDeliveryError("timeout", true));
      });
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > CALLBACK_MAX_RESPONSE_BYTES) {
          response.destroy();
          finish(new CallbackDeliveryError("response_too_large", false));
        }
      });
      response.on("end", () => finish(undefined, { status: response.statusCode ?? 0, bytes }));
      response.on("error", () => finish(new CallbackDeliveryError("network_error", true)));
    });
    req.setTimeout(CALLBACK_CONNECT_TIMEOUT_MS, () => {
      req.destroy();
      finish(new CallbackDeliveryError("timeout", true));
    });
    req.on("error", () => finish(new CallbackDeliveryError("network_error", true)));
    req.end(body);
  });
}

export const deliverCallbackHttp: CallbackTransport = async (target, body, signature) =>
  nodeRuntime() ? nodePinnedTransport(target, body, signature) : edgeTransport(target, body, signature);

function classifyStatus(status: number): void {
  if (status >= 200 && status < 300) return;
  if (status >= 300 && status < 400) throw new CallbackDeliveryError("redirect_refused", false);
  if (status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)) {
    throw new CallbackDeliveryError(`http_${status}`, true);
  }
  if (status >= 400 && status < 500) throw new CallbackDeliveryError(`http_${status}`, false);
  throw new CallbackDeliveryError("http_status", false);
}

/** Sends the canonical body signed byte-for-byte by the production webhook signer. */
export async function sendApprovalCallback(
  job: OutboxJob,
  dependencies: CallbackDeliveryDependencies = {},
): Promise<{ event: ApprovalResolvedEventType; body: string; status: number }> {
  const sql = dependencies.sql ?? database().sql;
  const row = await loadCallback(sql, job);
  const event = callbackEvent(row);
  const body = canonicalize(event);
  const signature = await (dependencies.sign ?? signWebhook)(event);
  let target: ValidatedPublicUrl;
  try {
    target = await validatePublicHttpsUrl(row.url, dependencies.resolve ? { resolve: dependencies.resolve } : {});
  } catch (error) {
    if (error instanceof PublicUrlValidationError) throw new CallbackDeliveryError(`url_${error.code}`, false);
    throw new CallbackDeliveryError("url_policy", false);
  }
  const response = await (dependencies.transport ?? deliverCallbackHttp)(target, body, signature);
  classifyStatus(response.status);
  return { event, body, status: response.status };
}

export function callbackRetryDelaySeconds(attempt: number, random = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt >= CALLBACK_MAX_ATTEMPTS) {
    throw new RangeError("Callback retry attempt is out of range");
  }
  return CALLBACK_RETRY_BASE_SECONDS * 2 ** (attempt - 1) * (0.5 + random());
}

export async function markCallbackDelivered(job: OutboxJob, sql: Sql = database().sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      update approval_callbacks set delivery_status = 'DELIVERED', completed_at = now(),
        dead_lettered_at = null, lease_expires_at = null, next_attempt_at = null, last_error = null
      where id = ${job.payload.callbackId!} and workspace_id = ${job.workspace_id}
    `;
    await tx`
      update jobs set state = 'SUCCEEDED', completed_at = now(), locked_at = null, last_error = null
      where id = ${job.id}
    `;
  });
}

export async function markCallbackFailed(
  job: OutboxJob,
  error: unknown,
  dependencies: CallbackMutationDependencies = {},
): Promise<"retry" | "dead_letter"> {
  const sql = dependencies.sql ?? database().sql;
  const failure = error instanceof CallbackDeliveryError
    ? error
    : new CallbackDeliveryError("delivery_error", true);
  const retry = failure.retryable && job.attempts < CALLBACK_MAX_ATTEMPTS;
  const delay = retry ? callbackRetryDelaySeconds(job.attempts, dependencies.random) : undefined;
  await sql.begin(async (tx) => {
    if (retry) {
      await tx`
        update approval_callbacks set delivery_status = 'FAILED', lease_expires_at = null,
          last_error = ${failure.code}, next_attempt_at = now() + make_interval(secs => ${delay!})
        where id = ${job.payload.callbackId!} and workspace_id = ${job.workspace_id}
      `;
      await tx`
        update jobs set state = 'FAILED', locked_at = null, last_error = ${failure.code},
          available_at = now() + make_interval(secs => ${delay!})
        where id = ${job.id}
      `;
    } else {
      await tx`
        update approval_callbacks set delivery_status = 'DEAD_LETTER', lease_expires_at = null,
          last_error = ${failure.code}, next_attempt_at = null, dead_lettered_at = now()
        where id = ${job.payload.callbackId!} and workspace_id = ${job.workspace_id}
      `;
      await tx`
        update jobs set state = 'DEAD_LETTER', locked_at = null, last_error = ${failure.code},
          completed_at = now()
        where id = ${job.id}
      `;
    }
  });
  return retry ? "retry" : "dead_letter";
}

export async function replayDeadLetterCallback(
  callbackId: string,
  sql: Sql = database().sql,
): Promise<{ id: string; status: "READY" }> {
  return sql.begin(async (tx) => {
    const rows = await tx`
      update approval_callbacks set delivery_status = 'READY', attempts = 0,
        next_attempt_at = now(), lease_expires_at = null, last_error = null,
        completed_at = null, dead_lettered_at = null
      where id = ${callbackId} and delivery_status = 'DEAD_LETTER'
      returning id
    `;
    if (!rows[0]) throw new CallbackDeliveryError("callback_not_dead_lettered", false);
    const jobs = await tx`
      update jobs set state = 'READY', attempts = 0, available_at = now(), locked_at = null,
        last_error = null, completed_at = null
      where type = ${CALLBACK_JOB_TYPE} and dedupe_key = ${callbackId}
      returning id
    `;
    if (!jobs[0]) throw new Error("Callback replay job is missing");
    return { id: callbackId, status: "READY" as const };
  });
}
