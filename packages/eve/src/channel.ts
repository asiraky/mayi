import {
  CallbackStateError,
  CALLBACK_ACCEPTANCE_WINDOW_SECONDS,
  MAYI_SIGNATURE_HEADER,
  MAX_WEBHOOK_BODY_BYTES,
  MayiClient,
  WebhookConfigurationError,
  WebhookVerificationError,
  createCallbackStateCodec,
  createWebhookVerifier,
  type CallbackStateCodec,
  type CallbackStateKey,
  type ArtefactBody,
  type ArtefactMediaType,
  type GetAccessToken,
  type MayiFetch,
  type WebhookVerifier,
  type WebhookVerifierFetch,
} from "@mayiapp/sdk";
import {
  POST,
  defineChannel,
  type Channel,
  type ChannelEvents,
  type RouteHandlerArgs,
  type SessionHandle,
} from "eve/channels";
import type { SandboxSession } from "eve/sandbox";
import {
  MAYI_CALLBACK_PATH,
  MayiEveConfigurationError,
  getRuntimeEnvironment,
  resolvePublicOrigin,
  type MayiEnvironment,
} from "./origin";

const DEFAULT_MAYI_ORIGIN = "https://app.mayi.sh";
const DEFAULT_APPROVAL_EXPIRES_IN_SECONDS = 60 * 60;
const MAYI_USER_ID_PATTERN = /^[A-Za-z]{12}$/;
const MAX_CONTINUATION_TOKEN_LENGTH = 4_096;
const MAX_CORRELATION_ID_LENGTH = 512;
const MAX_EXPIRY_LENGTH = 64;
const ACCEPTANCE_RECONCILIATION_TIMEOUT_MS = 2_000;
const DEFAULT_ARTEFACT_TIMEOUT_MS = 30_000;
const MAX_ARTEFACTS = 20;
const ARTEFACT_CONCURRENCY = 3;
export const MAX_CALLBACK_BODY_BYTES = MAX_WEBHOOK_BODY_BYTES;

export interface MayiReceiveTarget {
  /** Mayi user to suggest as the approver for approvals started by this session. */
  readonly mayiUserId?: string;
}

export interface MayiChannelState {
  /** The channel-local token passed to Eve send(); never derive this by stripping a namespace. */
  rawContinuationToken: string | null;
  target: MayiReceiveTarget | null;
  /** Opaque callback material retained so a redelivered Eve event is retry-compatible. */
  callbackRequests?: Record<string, MayiCallbackRequestState>;
}

export interface MayiCallbackRequestState {
  readonly state: string;
  readonly approvalExpiresAt: string;
}

export interface MayiContinuationStateV1 {
  readonly version: 1;
  readonly rawContinuationToken: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

export interface MayiWebhookEventStore {
  /** Returns true only after Eve has accepted this event's resume. */
  readonly isProcessed: (eventId: string) => boolean | Promise<boolean>;
  /** Durably records an event after Eve has accepted its resume. */
  readonly markProcessed: (eventId: string) => void | Promise<void>;
}

export type MayiArtefactMediaType = ArtefactMediaType;
export type MayiArtefactBody = ArtefactBody;

export interface MayiApprovalArtefact {
  readonly filename: string;
  readonly mediaType: MayiArtefactMediaType;
  readonly body: MayiArtefactBody;
  readonly size?: number;
}

export interface MayiArtefactsContext {
  readonly request: Readonly<EveInputRequest>;
  readonly session: Readonly<Pick<SessionHandle, "id" | "continuationToken" | "auth">>;
  readonly getSandbox: () => Promise<SandboxSession>;
  readonly signal: AbortSignal;
}

export type MayiArtefactsHook = (
  context: MayiArtefactsContext,
) => readonly MayiApprovalArtefact[] | null | undefined | Promise<readonly MayiApprovalArtefact[] | null | undefined>;

export interface MayiChannelConfig {
  readonly getAccessToken: GetAccessToken;
  /** Mayi API origin. Defaults to MAYI_ORIGIN, then https://app.mayi.sh. */
  readonly mayiOrigin?: string;
  /** Explicit HTTPS origin for local development or a tunnel. Never used in production. */
  readonly publicOrigin?: string;
  readonly approvalExpiresInSeconds?: number;
  readonly fetch?: MayiFetch;
  /** Produces evidence before the gated tool executes. Omit to preserve the no-evidence path. */
  readonly artefacts?: MayiArtefactsHook;
  /** Maximum time for one request's hook and uploads. Defaults to 30 seconds. */
  readonly artefactTimeoutMs?: number;
  /** Optional durable duplicate fence. Both hooks must be backed by the same store. */
  readonly eventStore?: MayiWebhookEventStore;
  /** Advanced host/testing injection for Mayi's public webhook JWKS request. */
  readonly webhookFetch?: WebhookVerifierFetch;
  /** Advanced host/testing injection. Normal deployments use the host-provisioned key environment. */
  readonly callbackStateCodec?: CallbackStateCodec;
  /** Advanced host/testing injection for runtimes that do not expose process.env. */
  readonly environment?: MayiEnvironment;
}

interface MayiChannelContext {
  state: MayiChannelState;
  session: Readonly<Pick<SessionHandle, "id" | "continuationToken" | "auth">>;
}

interface InputRequestData {
  readonly requests: readonly EveInputRequest[];
}

export interface EveInputRequest {
  readonly action: {
    readonly kind: "tool-call";
    readonly toolName: string;
    readonly callId: string;
    readonly input: Record<string, unknown>;
  };
  readonly allowFreeform?: boolean;
  readonly display?: "confirmation" | "select" | "text";
  readonly options?: readonly { readonly id: string }[];
  readonly prompt: string;
  readonly requestId: string;
}

interface MayiInputChannel {
  readonly state: MayiChannelState;
  readonly session?: Readonly<Pick<SessionHandle, "id" | "continuationToken" | "auth">>;
}

interface MayiInputContext {
  readonly session: { readonly id: string };
  readonly getSandbox?: () => Promise<SandboxSession>;
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

interface MayiChannelRuntime {
  readonly client: MayiClient;
  readonly artefacts?: MayiArtefactsHook;
  readonly artefactSemaphore: Semaphore;
  readonly artefactTimeoutMs: number;
  readonly codec: () => Promise<CallbackStateCodec>;
  readonly environment: MayiEnvironment;
  readonly eventStore?: MayiWebhookEventStore;
  readonly expiresInSeconds: number;
  readonly now: () => number;
  readonly publicOriginOverride?: string;
  readonly verifier: () => WebhookVerifier;
}

export class UnsupportedMayiInputError extends Error {
  readonly requestId: string;

  constructor(requestId: string, display = "unspecified") {
    super(
      `@mayiapp/eve supports only tool approval confirmations; Eve input request "${requestId}" uses unsupported display "${display}"`,
    );
    this.name = "UnsupportedMayiInputError";
    this.requestId = requestId;
  }
}

function parsePreviousKeys(value: string | undefined): CallbackStateKey[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MayiEveConfigurationError(
      "INVALID_CALLBACK_STATE_KEYS",
      "MAYI_CALLBACK_STATE_PREVIOUS_KEYS must be a JSON array of callback-state keys",
    );
  }
  if (
    !Array.isArray(parsed)
    || parsed.some((item) => (
      !item
      || typeof item !== "object"
      || Array.isArray(item)
      || Object.keys(item).some((key) => key !== "kid" && key !== "key")
      || typeof (item as Record<string, unknown>).kid !== "string"
      || typeof (item as Record<string, unknown>).key !== "string"
    ))
  ) {
    throw new MayiEveConfigurationError(
      "INVALID_CALLBACK_STATE_KEYS",
      "MAYI_CALLBACK_STATE_PREVIOUS_KEYS must be a JSON array of callback-state keys",
    );
  }
  return parsed as CallbackStateKey[];
}

async function callbackStateCodecFromEnvironment(environment: MayiEnvironment): Promise<CallbackStateCodec> {
  const kid = environment.MAYI_CALLBACK_STATE_KEY_ID;
  const key = environment.MAYI_CALLBACK_STATE_KEY;
  if (!kid || !key) {
    throw new MayiEveConfigurationError(
      "CALLBACK_STATE_KEY_UNAVAILABLE",
      "The host must provision MAYI_CALLBACK_STATE_KEY_ID and MAYI_CALLBACK_STATE_KEY",
    );
  }
  try {
    return await createCallbackStateCodec({
      currentKey: { kid, key },
      previousKeys: parsePreviousKeys(environment.MAYI_CALLBACK_STATE_PREVIOUS_KEYS),
      maximumRetryWindowSeconds: CALLBACK_ACCEPTANCE_WINDOW_SECONDS,
    });
  } catch (error) {
    if (error instanceof MayiEveConfigurationError) throw error;
    throw new MayiEveConfigurationError(
      "INVALID_CALLBACK_STATE_KEYS",
      "The host-provisioned callback-state key configuration is invalid",
    );
  }
}

export function createRuntime(
  config: MayiChannelConfig,
  dependencies: { readonly now?: () => number } = {},
): MayiChannelRuntime {
  if (!config || typeof config !== "object" || typeof config.getAccessToken !== "function") {
    throw new MayiEveConfigurationError("INVALID_CONFIG", "mayiChannel requires getAccessToken");
  }
  const expiresInSeconds = config.approvalExpiresInSeconds ?? DEFAULT_APPROVAL_EXPIRES_IN_SECONDS;
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 7 * 24 * 60 * 60) {
    throw new MayiEveConfigurationError(
      "INVALID_CONFIG",
      "approvalExpiresInSeconds must be an integer between 60 and 604800",
    );
  }
  if (
    config.eventStore !== undefined
    && (
      !config.eventStore
      || typeof config.eventStore !== "object"
      || typeof config.eventStore.isProcessed !== "function"
      || typeof config.eventStore.markProcessed !== "function"
    )
  ) {
    throw new MayiEveConfigurationError(
      "INVALID_CONFIG",
      "eventStore must provide both isProcessed and markProcessed",
    );
  }
  const artefactTimeoutMs = config.artefactTimeoutMs ?? DEFAULT_ARTEFACT_TIMEOUT_MS;
  if (!Number.isInteger(artefactTimeoutMs) || artefactTimeoutMs < 1 || artefactTimeoutMs > 5 * 60 * 1_000) {
    throw new MayiEveConfigurationError(
      "INVALID_CONFIG",
      "artefactTimeoutMs must be an integer between 1 and 300000",
    );
  }
  if (config.artefacts !== undefined && typeof config.artefacts !== "function") {
    throw new MayiEveConfigurationError("INVALID_CONFIG", "artefacts must be a function");
  }
  const environment = config.environment ?? getRuntimeEnvironment();
  const mayiOrigin = config.mayiOrigin ?? environment.MAYI_ORIGIN ?? DEFAULT_MAYI_ORIGIN;
  const client = new MayiClient({
    origin: mayiOrigin,
    getAccessToken: config.getAccessToken,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });
  let codecPromise: Promise<CallbackStateCodec> | undefined;
  let verifier: WebhookVerifier | undefined;
  return {
    ...(config.artefacts === undefined ? {} : { artefacts: config.artefacts }),
    artefactSemaphore: new Semaphore(ARTEFACT_CONCURRENCY),
    artefactTimeoutMs,
    client,
    environment,
    ...(config.eventStore === undefined ? {} : { eventStore: config.eventStore }),
    expiresInSeconds,
    now: dependencies.now ?? Date.now,
    ...(config.publicOrigin === undefined ? {} : { publicOriginOverride: config.publicOrigin }),
    codec() {
      codecPromise ??= config.callbackStateCodec
        ? Promise.resolve(config.callbackStateCodec)
        : callbackStateCodecFromEnvironment(environment);
      return codecPromise;
    },
    verifier() {
      verifier ??= createWebhookVerifier({
        mayiOrigin,
        maximumEventAgeSeconds: CALLBACK_ACCEPTANCE_WINDOW_SECONDS,
        now: dependencies.now ?? Date.now,
        ...(config.webhookFetch === undefined ? {} : { fetch: config.webhookFetch }),
        ...(config.eventStore === undefined ? {} : { isProcessed: config.eventStore.isProcessed }),
      });
      return verifier;
    },
  };
}

function isApprovalRequest(request: EveInputRequest): boolean {
  if (request.display !== "confirmation" || request.allowFreeform === true) return false;
  const optionIds = request.options?.map((option) => option.id) ?? [];
  return optionIds.length === 2 && optionIds.includes("approve") && optionIds.includes("deny");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function createMayiIdempotencyKey(sessionId: string, requestId: string): Promise<string> {
  const material = new TextEncoder().encode(JSON.stringify(["mayi-eve-v1", sessionId, requestId]));
  const digest = await crypto.subtle.digest("SHA-256", material);
  return `mayi:eve:v1:${bytesToBase64Url(new Uint8Array(digest))}`;
}

async function submitOneRequest(
  request: EveInputRequest,
  channel: MayiInputChannel,
  context: MayiInputContext,
  runtime: MayiChannelRuntime,
): Promise<void> {
  if (!isApprovalRequest(request)) {
    throw new UnsupportedMayiInputError(request.requestId, request.display);
  }
  const rawContinuationToken = channel.state.rawContinuationToken;
  if (!rawContinuationToken || !channel.state.target) {
    throw new MayiEveConfigurationError(
      "INVALID_CONFIG",
      "The Mayi channel is missing its durable receive state",
    );
  }

  let callbackRequest = channel.state.callbackRequests?.[request.requestId];
  if (!callbackRequest) {
    const now = runtime.now();
    const approvalExpiresAt = new Date(now + runtime.expiresInSeconds * 1_000).toISOString();
    const stateExpiresAt = new Date(
      now + (runtime.expiresInSeconds + CALLBACK_ACCEPTANCE_WINDOW_SECONDS) * 1_000,
    ).toISOString();
    const codec = await runtime.codec();
    const state = await codec.seal({
      version: 1,
      rawContinuationToken,
      requestId: request.requestId,
      sessionId: context.session.id,
      expiresAt: stateExpiresAt,
    } satisfies MayiContinuationStateV1, { approvalExpiresAt });
    callbackRequest = { state, approvalExpiresAt };
    channel.state.callbackRequests ??= {};
    channel.state.callbackRequests[request.requestId] = callbackRequest;
  }
  const publicOrigin = resolvePublicOrigin({
    environment: runtime.environment,
    ...(runtime.publicOriginOverride === undefined
      ? {}
      : { developmentOverride: runtime.publicOriginOverride }),
  });
  const idempotencyKey = await createMayiIdempotencyKey(context.session.id, request.requestId);
  const artefactIds = await stageRequestArtefacts(request, channel, context, runtime, idempotencyKey);
  await runtime.client.approvals.request({
    action: request.action,
    explanation: request.prompt,
    expiresInSeconds: runtime.expiresInSeconds,
    ...(channel.state.target.mayiUserId === undefined
      ? {}
      : { suggestedApproverId: channel.state.target.mayiUserId }),
    callback: {
      url: `${publicOrigin}${MAYI_CALLBACK_PATH}`,
      state: callbackRequest.state,
    },
    ...(artefactIds === undefined ? {} : { artefactIds }),
  }, { idempotencyKey });
}

async function stageRequestArtefacts(
  request: EveInputRequest,
  channel: MayiInputChannel,
  context: MayiInputContext,
  runtime: MayiChannelRuntime,
  idempotencyKey: string,
): Promise<string[] | undefined> {
  if (!runtime.artefacts) return undefined;
  if (!channel.session || !context.getSandbox) {
    throw new MayiEveConfigurationError("INVALID_CONFIG", "Eve did not provide the artefact hook context");
  }
  const session = channel.session;
  const getSandbox = context.getSandbox;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Mayi artefact preparation timed out")), runtime.artefactTimeoutMs);
  try {
    return await Promise.race([
      runtime.artefactSemaphore.run(async () => {
        const artefacts = await runtime.artefacts!({
          request,
          session,
          getSandbox,
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw controller.signal.reason;
        if (artefacts == null || artefacts.length === 0) return undefined;
        if (!Array.isArray(artefacts) || artefacts.length > MAX_ARTEFACTS) {
          throw new MayiEveConfigurationError("INVALID_CONFIG", "artefacts must return at most 20 items");
        }
        const ids: string[] = [];
        for (const [ordinal, artefact] of artefacts.entries()) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const staged = await runtime.client.stageRequestArtefact(
            idempotencyKey,
            ordinal,
            artefact.filename,
            artefact.mediaType,
            artefact.body,
            {
              signal: controller.signal,
              ...(artefact.size === undefined ? {} : { size: artefact.size }),
            },
          );
          ids.push(staged.id);
        }
        return ids;
      }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function createInputRequestedHandler(runtime: MayiChannelRuntime) {
  return async (data: InputRequestData, channel: MayiInputChannel, context: MayiInputContext): Promise<void> => {
    const results = await Promise.allSettled(
      data.requests.map((request) => submitOneRequest(request, channel, context, runtime)),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, "One or more Mayi approval requests failed");
  };
}

function genericResponse(status: number, message: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function readCallbackBody(request: Request): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null
    && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_CALLBACK_BODY_BYTES)
  ) throw new Error("Invalid callback request");
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CALLBACK_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Invalid callback request");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Invalid callback request");
  }
}

function validBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function parseContinuationState(value: unknown, currentTime: number): MayiContinuationStateV1 {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 5
    || (value as Record<string, unknown>).version !== 1
    || !validBoundedString(
      (value as Record<string, unknown>).rawContinuationToken,
      MAX_CONTINUATION_TOKEN_LENGTH,
    )
    || !validBoundedString((value as Record<string, unknown>).requestId, MAX_CORRELATION_ID_LENGTH)
    || !validBoundedString((value as Record<string, unknown>).sessionId, MAX_CORRELATION_ID_LENGTH)
    || !validBoundedString((value as Record<string, unknown>).expiresAt, MAX_EXPIRY_LENGTH)
  ) throw new CallbackStateError("INVALID_STATE");
  const state = value as MayiContinuationStateV1;
  const expiresAt = Date.parse(state.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new CallbackStateError("INVALID_STATE");
  if (expiresAt <= currentTime) throw new CallbackStateError("EXPIRED");
  return state;
}

async function requestWasAccepted(
  getSession: RouteHandlerArgs<MayiChannelState>["getSession"],
  sessionId: string,
  requestId: string,
): Promise<boolean> {
  let callId: string | undefined;
  try {
    const stream = await getSession(sessionId).getEventStream();
    const reader = stream.getReader();
    try {
      const deadline = Date.now() + ACCEPTANCE_RECONCILIATION_TIMEOUT_MS;
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          await reader.cancel();
          return false;
        }
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => {
            timeout = setTimeout(() => resolve(null), remaining);
          }),
        ]).finally(() => clearTimeout(timeout));
        if (result === null) {
          await reader.cancel();
          return false;
        }
        const { done, value } = result;
        if (done) return false;
        if (value.type === "input.requested") {
          const request = value.data.requests.find((candidate) => candidate.requestId === requestId);
          if (request?.action.kind === "tool-call") callId = request.action.callId;
        } else if (
          callId !== undefined
          && value.type === "action.result"
          && value.data.result.kind === "tool-result"
          && value.data.result.callId === callId
        ) {
          return true;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch {
    return false;
  }
}

async function markProcessed(eventId: string, runtime: MayiChannelRuntime): Promise<boolean> {
  if (!runtime.eventStore) return true;
  try {
    await runtime.eventStore.markProcessed(eventId);
    return true;
  } catch {
    return false;
  }
}

async function alreadyProcessed(eventId: string, runtime: MayiChannelRuntime): Promise<boolean> {
  if (!runtime.eventStore) return false;
  try {
    return await runtime.eventStore.isProcessed(eventId) === true;
  } catch {
    return false;
  }
}

export function createApprovalResolvedHandler(runtime: MayiChannelRuntime) {
  return async (
    request: Request,
    args: RouteHandlerArgs<MayiChannelState>,
  ): Promise<Response> => {
    let body: string;
    try {
      body = await readCallbackBody(request);
    } catch {
      return genericResponse(400, "Invalid callback request");
    }

    let verification: Awaited<ReturnType<WebhookVerifier["verify"]>>;
    try {
      verification = await runtime.verifier().verify({
        body,
        signature: request.headers.get(MAYI_SIGNATURE_HEADER),
      });
    } catch (error) {
      if (error instanceof WebhookConfigurationError) {
        return genericResponse(503, "Callback verification is temporarily unavailable");
      }
      if (
        error instanceof WebhookVerificationError
        && (error.code === "KEY_SET_UNAVAILABLE" || error.code === "DUPLICATE_CHECK_FAILED")
      ) return genericResponse(503, "Callback verification is temporarily unavailable");
      return genericResponse(401, "Callback verification failed");
    }
    if (verification.duplicate) {
      return new Response(null, { status: 208, headers: { "cache-control": "no-store" } });
    }

    let state: MayiContinuationStateV1;
    let codec: CallbackStateCodec;
    try {
      codec = await runtime.codec();
    } catch {
      return genericResponse(503, "Callback state handling is temporarily unavailable");
    }
    try {
      state = parseContinuationState(
        await codec.open<unknown>(verification.event.state),
        runtime.now(),
      );
    } catch {
      return genericResponse(400, "Callback state is invalid");
    }

    const optionId = verification.event.status === "approved" ? "approve" : "deny";
    try {
      const session = await args.send({
        inputResponses: [{ requestId: state.requestId, optionId }],
      }, {
        auth: null,
        continuationToken: state.rawContinuationToken,
        state: { rawContinuationToken: state.rawContinuationToken, target: null },
      });
      if (session.id !== state.sessionId) throw new Error("resume session mismatch");
    } catch {
      if (await alreadyProcessed(verification.event.id, runtime)) {
        return new Response(null, { status: 208, headers: { "cache-control": "no-store" } });
      }
      if (!await requestWasAccepted(args.getSession, state.sessionId, state.requestId)) {
        return genericResponse(503, "Eve did not accept the callback resume");
      }
      if (!await markProcessed(verification.event.id, runtime)) {
        return genericResponse(503, "Callback acknowledgement is temporarily unavailable");
      }
      return new Response(null, { status: 208, headers: { "cache-control": "no-store" } });
    }

    if (!await markProcessed(verification.event.id, runtime)) {
      return genericResponse(503, "Callback acknowledgement is temporarily unavailable");
    }
    return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  };
}

function createRawContinuationToken(): string {
  if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== "function") {
    throw new MayiEveConfigurationError("INVALID_CONFIG", "A cryptographically secure random UUID source is required");
  }
  // The colon deliberately demonstrates why callers must retain the raw value
  // instead of trying to strip Eve's own channel namespace later.
  return `mayi:${globalThis.crypto.randomUUID()}`;
}

export function mayiChannel(config: MayiChannelConfig): Channel<MayiChannelState, MayiReceiveTarget> {
  const runtime = createRuntime(config);
  const inputRequested = createInputRequestedHandler(runtime) as NonNullable<
    ChannelEvents<MayiChannelContext>["input.requested"]
  >;

  return defineChannel<MayiChannelState, MayiChannelContext, MayiReceiveTarget>({
    kindHint: "mayi",
    state: { rawContinuationToken: null, target: null, callbackRequests: {} },
    context(state, session) {
      return {
        state,
        session: { id: session.id, continuationToken: session.continuationToken, auth: session.auth },
      };
    },
    routes: [POST<MayiChannelState>(MAYI_CALLBACK_PATH, createApprovalResolvedHandler(runtime))],
    async receive(input, { send }) {
      const mayiUserId = input.target.mayiUserId;
      if (mayiUserId !== undefined && !MAYI_USER_ID_PATTERN.test(mayiUserId)) {
        throw new MayiEveConfigurationError(
          "INVALID_RECEIVE_TARGET",
          "target.mayiUserId must be exactly 12 ASCII letters",
        );
      }
      const rawContinuationToken = createRawContinuationToken();
      const target = mayiUserId === undefined ? {} : { mayiUserId };
      return send(input.message, {
        auth: input.auth,
        continuationToken: rawContinuationToken,
        state: { rawContinuationToken, target, callbackRequests: {} },
      });
    },
    events: { "input.requested": inputRequested },
  });
}
