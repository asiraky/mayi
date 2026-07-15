import {
  MayiClient,
  createCallbackStateCodec,
  type CallbackStateCodec,
  type CallbackStateKey,
  type GetAccessToken,
  type MayiFetch,
} from "@mayi/sdk";
import {
  POST,
  defineChannel,
  type Channel,
  type ChannelEvents,
} from "eve/channels";
import {
  MAYI_CALLBACK_PATH,
  MayiEveConfigurationError,
  getRuntimeEnvironment,
  resolvePublicOrigin,
  type MayiEnvironment,
} from "./origin";

const DEFAULT_MAYI_ORIGIN = "https://app.mayi.sh";
const DEFAULT_APPROVAL_EXPIRES_IN_SECONDS = 60 * 60;
// The Mayi callback outbox's maximum exponential-backoff window is 3,832.5s.
const CALLBACK_MAX_RETRY_WINDOW_SECONDS = 3_833;
const MAYI_USER_ID_PATTERN = /^[A-Za-z]{12}$/;

export interface MayiReceiveTarget {
  /** Mayi user to suggest as the approver for approvals started by this session. */
  readonly mayiUserId?: string;
}

export interface MayiChannelState {
  /** The channel-local token passed to Eve send(); never derive this by stripping a namespace. */
  rawContinuationToken: string | null;
  target: MayiReceiveTarget | null;
}

export interface MayiContinuationStateV1 {
  readonly version: 1;
  readonly rawContinuationToken: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

export interface MayiChannelConfig {
  readonly getAccessToken: GetAccessToken;
  /** Mayi API origin. Defaults to MAYI_ORIGIN, then https://app.mayi.sh. */
  readonly mayiOrigin?: string;
  /** Explicit HTTPS origin for local development or a tunnel. Never used in production. */
  readonly publicOrigin?: string;
  readonly approvalExpiresInSeconds?: number;
  readonly fetch?: MayiFetch;
  /** Advanced host/testing injection. Normal deployments use the host-provisioned key environment. */
  readonly callbackStateCodec?: CallbackStateCodec;
  /** Advanced host/testing injection for runtimes that do not expose process.env. */
  readonly environment?: MayiEnvironment;
}

interface MayiChannelContext {
  state: MayiChannelState;
}

interface InputRequestData {
  readonly requests: readonly EveInputRequest[];
}

interface EveInputRequest {
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
}

interface MayiInputContext {
  readonly session: { readonly id: string };
}

interface MayiChannelRuntime {
  readonly client: MayiClient;
  readonly codec: () => Promise<CallbackStateCodec>;
  readonly environment: MayiEnvironment;
  readonly expiresInSeconds: number;
  readonly now: () => number;
  readonly publicOriginOverride?: string;
}

export class UnsupportedMayiInputError extends Error {
  readonly requestId: string;

  constructor(requestId: string, display = "unspecified") {
    super(
      `@mayi/eve supports only tool approval confirmations; Eve input request "${requestId}" uses unsupported display "${display}"`,
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
      maximumRetryWindowSeconds: CALLBACK_MAX_RETRY_WINDOW_SECONDS,
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
  const environment = config.environment ?? getRuntimeEnvironment();
  const client = new MayiClient({
    origin: config.mayiOrigin ?? environment.MAYI_ORIGIN ?? DEFAULT_MAYI_ORIGIN,
    getAccessToken: config.getAccessToken,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });
  let codecPromise: Promise<CallbackStateCodec> | undefined;
  return {
    client,
    environment,
    expiresInSeconds,
    now: dependencies.now ?? Date.now,
    ...(config.publicOrigin === undefined ? {} : { publicOriginOverride: config.publicOrigin }),
    codec() {
      codecPromise ??= config.callbackStateCodec
        ? Promise.resolve(config.callbackStateCodec)
        : callbackStateCodecFromEnvironment(environment);
      return codecPromise;
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

  const now = runtime.now();
  const approvalExpiresAt = new Date(now + runtime.expiresInSeconds * 1_000).toISOString();
  const stateExpiresAt = new Date(
    now + (runtime.expiresInSeconds + CALLBACK_MAX_RETRY_WINDOW_SECONDS) * 1_000,
  ).toISOString();
  const codec = await runtime.codec();
  const state = await codec.seal({
    version: 1,
    rawContinuationToken,
    requestId: request.requestId,
    sessionId: context.session.id,
    expiresAt: stateExpiresAt,
  } satisfies MayiContinuationStateV1, { approvalExpiresAt });
  const publicOrigin = resolvePublicOrigin({
    environment: runtime.environment,
    ...(runtime.publicOriginOverride === undefined
      ? {}
      : { developmentOverride: runtime.publicOriginOverride }),
  });
  const idempotencyKey = await createMayiIdempotencyKey(context.session.id, request.requestId);
  await runtime.client.approvals.request({
    action: request.action,
    explanation: request.prompt,
    expiresInSeconds: runtime.expiresInSeconds,
    ...(channel.state.target.mayiUserId === undefined
      ? {}
      : { suggestedApproverId: channel.state.target.mayiUserId }),
    callback: {
      url: `${publicOrigin}${MAYI_CALLBACK_PATH}`,
      state,
    },
  }, { idempotencyKey });
}

export function createInputRequestedHandler(runtime: MayiChannelRuntime) {
  return async (data: InputRequestData, channel: MayiInputChannel, context: MayiInputContext): Promise<void> => {
    await Promise.all(data.requests.map((request) => submitOneRequest(request, channel, context, runtime)));
  };
}

async function callbackHandler(): Promise<Response> {
  return Response.json(
    { error: "The Mayi approval callback resume handler is not available in this package version" },
    { status: 501 },
  );
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
    state: { rawContinuationToken: null, target: null },
    context(state) {
      return { state };
    },
    routes: [POST<MayiChannelState>(MAYI_CALLBACK_PATH, callbackHandler)],
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
        state: { rawContinuationToken, target },
      });
    },
    events: { "input.requested": inputRequested },
  });
}
