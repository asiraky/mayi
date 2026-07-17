import {
  Approval as ApprovalSchema,
  Artefact as ArtefactSchema,
  Input as InputSchema,
  createId,
} from "@mayi/contracts";
import type {
  Approval,
  ApprovalRequest,
  Artefact,
  CreateApproval,
  Decision,
  Input,
  InputAnswer,
  InputRequest,
  Session,
  StagedArtefact,
} from "./public-contracts";

export type {
  Action,
  Approval,
  ApprovalCallback,
  ApprovalRequest,
  ApprovalResolvedEvent,
  ApprovalState,
  Artefact,
  CreateApproval,
  Decision,
  EnforcementMode,
  Input,
  InputAnswer,
  InputOption,
  InputRequest,
  InputResolvedEvent,
  InputState,
  InputType,
  Session,
  StagedArtefact,
  ToolCallAction,
  VersionedAction,
  WebhookEvent,
} from "./public-contracts";

export * from "./callback-state";
export * from "./webhook-verifier";

export type GetAccessToken = () => Promise<string>;
export type MayiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MayiClientOptions {
  origin: string;
  getAccessToken?: GetAccessToken;
  fetch?: MayiFetch;
  /** Allows cleartext HTTP only for exact loopback hosts during local development. */
  dangerouslyAllowInsecureHttpForDevelopment?: boolean;
}

export interface ApprovalRequestOptions {
  idempotencyKey: string;
}

export interface InputRequestOptions {
  idempotencyKey: string;
}

export interface ListInputsParams {
  state?: string | undefined;
}

export interface StageRequestArtefactOptions {
  signal?: AbortSignal | undefined;
  size?: number | undefined;
}

export type PendingApproval = Approval & {
  state: "PENDING";
  sealedAt: string;
  actionDigest: string;
  manifestDigest: string;
};
export type PendingInput = Input & { state: "PENDING" };
export type UploadedArtefact = Omit<Artefact, "ordinal">;
export type ArtefactMediaType = "application/pdf" | "image/png" | "image/jpeg" | "image/webp";
export type ArtefactBody = Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;

const MAX_ARTEFACT_SIZE = 25 * 1024 * 1024;
const ARTEFACT_MEDIA_TYPES = new Set<ArtefactMediaType>([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function limitArtefactStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let size = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        if (!(result.value instanceof Uint8Array)) {
          await reader.cancel("Artefact streams must contain Uint8Array chunks");
          controller.error(new MayiConfigurationError("artefact streams must contain byte chunks"));
          return;
        }
        size += result.value.byteLength;
        if (size > MAX_ARTEFACT_SIZE) {
          await reader.cancel("Artefact exceeds 25 MiB");
          controller.error(new MayiConfigurationError("artefact size must not exceed 25 MiB"));
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
}

export class MayiConfigurationError extends Error {
  constructor(message = "The Mayi client configuration is invalid") {
    super(message);
    this.name = "MayiConfigurationError";
  }
}

export class MayiAuthenticationError extends Error {
  readonly code: "ACCESS_TOKEN_PROVIDER_REQUIRED" | "ACCESS_TOKEN_UNAVAILABLE";

  constructor(code: "ACCESS_TOKEN_PROVIDER_REQUIRED" | "ACCESS_TOKEN_UNAVAILABLE") {
    super(code === "ACCESS_TOKEN_PROVIDER_REQUIRED"
      ? "An access token provider is required for this operation"
      : "The access token provider did not return a valid token");
    this.name = "MayiAuthenticationError";
    this.code = code;
  }
}

export class MayiNetworkError extends Error {
  constructor() {
    super("The request could not reach the Mayi service");
    this.name = "MayiNetworkError";
  }
}

export class MayiHttpError extends Error {
  readonly status: number;
  readonly code: "step_up_required" | undefined;

  constructor(status: number, code?: "step_up_required") {
    super("The Mayi service rejected the request");
    this.name = "MayiHttpError";
    this.status = status;
    this.code = code;
  }
}

export class MayiResponseError extends Error {
  constructor() {
    super("The Mayi service returned an invalid response");
    this.name = "MayiResponseError";
  }
}

type AuthMode = "cookie" | "optional-access-token" | "required-access-token";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizeOrigin(origin: string, allowInsecureLoopback: boolean): string {
  try {
    const url = new URL(origin);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) throw new Error();
    if (url.protocol === "http:" && !(allowInsecureLoopback && isLoopbackHostname(url.hostname))) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new MayiConfigurationError();
  }
}

function defaultFetch(): MayiFetch {
  if (typeof globalThis.fetch !== "function") {
    throw new MayiConfigurationError("A fetch implementation is required in this runtime");
  }
  return globalThis.fetch.bind(globalThis);
}

function validIdempotencyKey(value: string): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 && value.trim().length > 0;
}

function validAccessToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}

function parseApproval(value: unknown): Approval {
  const parsed = ApprovalSchema.safeParse(value);
  if (!parsed.success) throw new MayiResponseError();
  return parsed.data;
}

function parsePendingApproval(value: unknown): PendingApproval {
  const approval = parseApproval(value);
  if (
    approval.state !== "PENDING"
    || approval.sealedAt === null
    || approval.actionDigest === null
    || approval.manifestDigest === null
  ) throw new MayiResponseError();
  return approval as PendingApproval;
}

function parsePendingInput(value: unknown): PendingInput {
  const parsed = InputSchema.safeParse(value);
  if (!parsed.success || parsed.data.state !== "PENDING") throw new MayiResponseError();
  return parsed.data as PendingInput;
}

export class MayiClient {
  readonly approvals: { request: (input: ApprovalRequest, options: ApprovalRequestOptions) => Promise<PendingApproval> };
  readonly inputs: {
    request: (input: InputRequest, options: InputRequestOptions) => Promise<PendingInput>;
    get: (id: string) => Promise<Input>;
    list: (params?: ListInputsParams) => Promise<Input[]>;
    cancel: (id: string) => Promise<Input>;
  };

  private readonly origin: string;
  private readonly getAccessToken: GetAccessToken | undefined;
  private readonly fetch: MayiFetch;

  constructor(options: MayiClientOptions) {
    if (!options || typeof options !== "object") throw new MayiConfigurationError();
    this.origin = normalizeOrigin(
      options.origin,
      options.dangerouslyAllowInsecureHttpForDevelopment === true,
    );
    this.getAccessToken = options.getAccessToken;
    this.fetch = options.fetch ?? defaultFetch();
    if (typeof this.fetch !== "function") throw new MayiConfigurationError("A valid fetch implementation is required");

    this.approvals = {
      request: (input, requestOptions) => this.requestApproval(input, requestOptions),
    };
    this.inputs = {
      request: (input, requestOptions) => this.requestInput(input, requestOptions),
      get: (id) => this.request(`/api/inputs/${encodeURIComponent(id)}`, {}, "optional-access-token") as Promise<Input>,
      list: (params) => this.request(`/api/inputs${params?.state ? `?state=${encodeURIComponent(params.state)}` : ""}`, {}, "optional-access-token") as Promise<Input[]>,
      cancel: (id) => this.request(`/api/inputs/${encodeURIComponent(id)}/cancel`, { method: "POST" }, "required-access-token") as Promise<Input>,
    };
  }

  private async accessToken(required: boolean): Promise<string | undefined> {
    if (!this.getAccessToken) {
      if (required) throw new MayiAuthenticationError("ACCESS_TOKEN_PROVIDER_REQUIRED");
      return undefined;
    }

    let token: unknown;
    try {
      token = await this.getAccessToken();
    } catch {
      throw new MayiAuthenticationError("ACCESS_TOKEN_UNAVAILABLE");
    }
    if (!validAccessToken(token)) throw new MayiAuthenticationError("ACCESS_TOKEN_UNAVAILABLE");
    return token;
  }

  private async request(path: string, init: RequestInit = {}, auth: AuthMode = "cookie"): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.delete("authorization");
    let credentials: RequestCredentials = "include";

    if (auth !== "cookie") {
      const token = await this.accessToken(auth === "required-access-token");
      if (token) {
        headers.set("authorization", `Bearer ${token}`);
        credentials = "omit";
      }
    }
    if (typeof init.body === "string" && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    let response: Response;
    try {
      response = await this.fetch(new URL(path, this.origin), { ...init, headers, credentials });
    } catch {
      throw new MayiNetworkError();
    }

    if (!response.ok) {
      let code: "step_up_required" | undefined;
      if (response.status === 403) {
        try {
          const error = await response.json() as { data?: { code?: unknown } };
          if (error.data?.code === "step_up_required") code = "step_up_required";
        } catch {
          // Error bodies are optional and are never exposed to callers.
        }
      }
      throw new MayiHttpError(response.status, code);
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new MayiResponseError();
    }
  }

  private async requestApproval(input: ApprovalRequest, options: ApprovalRequestOptions): Promise<PendingApproval> {
    if (!options || !validIdempotencyKey(options.idempotencyKey)) {
      throw new MayiConfigurationError("idempotencyKey must contain 1 to 200 characters");
    }
    const value = await this.request("/api/approvals/request", {
      method: "POST",
      headers: { "idempotency-key": options.idempotencyKey },
      body: JSON.stringify(input),
    }, "required-access-token");
    return parsePendingApproval(value);
  }

  private async requestInput(input: InputRequest, options: InputRequestOptions): Promise<PendingInput> {
    if (!options || !validIdempotencyKey(options.idempotencyKey)) {
      throw new MayiConfigurationError("idempotencyKey must contain 1 to 200 characters");
    }
    const value = await this.request("/api/inputs", {
      method: "POST",
      headers: { "idempotency-key": options.idempotencyKey },
      body: JSON.stringify(input),
    }, "required-access-token");
    return parsePendingInput(value);
  }

  async stageRequestArtefact(
    requestKey: string,
    ordinal: number,
    filename: string,
    mediaType: ArtefactMediaType,
    body: ArtefactBody,
    options: StageRequestArtefactOptions = {},
  ): Promise<StagedArtefact> {
    if (!validIdempotencyKey(requestKey)) {
      throw new MayiConfigurationError("requestKey must contain 1 to 200 characters");
    }
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= 20) {
      throw new MayiConfigurationError("ordinal must be an integer between 0 and 19");
    }
    if (typeof filename !== "string" || filename.trim().length < 1 || filename.length > 255) {
      throw new MayiConfigurationError("filename must contain 1 to 255 characters");
    }
    if (!ARTEFACT_MEDIA_TYPES.has(mediaType)) {
      throw new MayiConfigurationError("mediaType must be PDF, PNG, JPEG, or WebP");
    }
    const knownSize = body instanceof Uint8Array
      ? body.byteLength
      : body instanceof ArrayBuffer
        ? body.byteLength
        : typeof Blob !== "undefined" && body instanceof Blob
          ? body.size
          : options.size;
    if (knownSize !== undefined && (!Number.isInteger(knownSize) || knownSize < 1 || knownSize > MAX_ARTEFACT_SIZE)) {
      throw new MayiConfigurationError("artefact size must be between 1 byte and 25 MiB");
    }

    const headers = new Headers({
      "content-type": mediaType,
      "idempotency-key": requestKey,
      "x-mayi-filename": encodeURIComponent(filename),
    });
    if (knownSize !== undefined) headers.set("content-length", String(knownSize));
    const requestBody = body instanceof ReadableStream ? limitArtefactStream(body) : body;
    const init: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers,
      body: requestBody as BodyInit,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    if (requestBody instanceof ReadableStream) init.duplex = "half";
    const value = await this.request(
      `/api/approvals/request/artefacts/${ordinal}`,
      init,
      "required-access-token",
    );
    const parsed = ArtefactSchema.omit({ ordinal: true }).safeParse(value);
    if (!parsed.success) throw new MayiResponseError();
    return parsed.data;
  }

  signup(input: { email: string; password: string; displayName: string; bootstrapSecret?: string }) {
    return this.request("/api/auth/signup", { method: "POST", body: JSON.stringify(input) }) as Promise<Session>;
  }

  signin(input: { email: string; password: string }) {
    return this.request("/api/auth/signin", { method: "POST", body: JSON.stringify(input) }) as Promise<Session>;
  }

  session() { return this.request("/api/auth/session") as Promise<Session>; }
  signout() { return this.request("/api/auth/signout", { method: "POST" }) as Promise<{ ok: true }>; }

  stepUp(input: { email: string; password: string }) {
    return this.request("/api/auth/step-up", { method: "POST", body: JSON.stringify(input) }) as Promise<{ ok: true }>;
  }

  passwordResetRequest(input: { email: string }) {
    return this.request("/api/auth/password-reset/request", { method: "POST", body: JSON.stringify(input) }) as Promise<{ ok: true }>;
  }

  passwordResetConfirm(input: { token: string; password: string }) {
    return this.request("/api/auth/password-reset/confirm", { method: "POST", body: JSON.stringify(input) }) as Promise<{ ok: true }>;
  }

  listApprovals(state?: string) {
    return this.request(`/api/approvals${state ? `?state=${encodeURIComponent(state)}` : ""}`, {}, "optional-access-token") as Promise<Approval[]>;
  }

  approval(id: string) {
    return this.request(`/api/approvals/${encodeURIComponent(id)}`, {}, "optional-access-token") as Promise<Approval>;
  }

  async createApproval(input: CreateApproval, idempotencyKey = createId()): Promise<Approval> {
    if (!validIdempotencyKey(idempotencyKey)) {
      throw new MayiConfigurationError("idempotencyKey must contain 1 to 200 characters");
    }
    const value = await this.request("/api/approvals", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    }, "required-access-token");
    return parseApproval(value);
  }

  async uploadArtefact(id: string, filename: string, mediaType: ArtefactMediaType, body: BodyInit): Promise<UploadedArtefact> {
    const value = await this.request(`/api/approvals/${encodeURIComponent(id)}/artefacts?filename=${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: { "content-type": mediaType },
      body,
    }, "required-access-token");
    const parsed = ArtefactSchema.omit({ ordinal: true }).safeParse(value);
    if (!parsed.success) throw new MayiResponseError();
    return parsed.data;
  }

  async sealApproval(id: string, artefactIds: string[]): Promise<PendingApproval> {
    const value = await this.request(`/api/approvals/${encodeURIComponent(id)}/seal`, {
      method: "POST",
      body: JSON.stringify({ artefactIds }),
    }, "required-access-token");
    return parsePendingApproval(value);
  }

  decide(id: string, input: Decision) {
    return this.request(`/api/approvals/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify(input) }) as Promise<Approval>;
  }

  listInputs(state?: string) {
    return this.request(`/api/inputs${state ? `?state=${encodeURIComponent(state)}` : ""}`) as Promise<Input[]>;
  }

  input(id: string) {
    return this.request(`/api/inputs/${encodeURIComponent(id)}`) as Promise<Input>;
  }

  answerInput(id: string, input: InputAnswer) {
    return this.request(`/api/inputs/${encodeURIComponent(id)}/answer`, { method: "POST", body: JSON.stringify(input) }) as Promise<Input>;
  }

  cancel(id: string) {
    return this.request(`/api/approvals/${encodeURIComponent(id)}/cancel`, { method: "POST" }, "required-access-token") as Promise<Approval>;
  }

  activity() { return this.request("/api/activity") as Promise<Array<Record<string, unknown>>>; }
  agents() { return this.request("/api/agents") as Promise<Array<Record<string, unknown>>>; }

  createAgent(input: { name: string; scopes: string[] }) {
    return this.request("/api/agents", { method: "POST", body: JSON.stringify(input) }) as Promise<{ id: string; token: string }>;
  }

  registerDevice(token: string, platform: "ios" | "android") {
    return this.request("/api/devices", { method: "POST", body: JSON.stringify({ token, platform }) }) as Promise<{ ok: true }>;
  }
}
