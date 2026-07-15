import {
  Approval as ApprovalSchema,
  Artefact as ArtefactSchema,
  createId,
  type Approval,
  type ApprovalRequest,
  type Artefact,
  type CreateApproval,
  type Decision,
  type Session,
} from "@mayi/contracts";

export type GetAccessToken = () => Promise<string>;
export type MayiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MayiClientOptions {
  origin: string;
  getAccessToken?: GetAccessToken;
  fetch?: MayiFetch;
}

export interface ApprovalRequestOptions {
  idempotencyKey: string;
}

export type PendingApproval = Approval & {
  state: "PENDING";
  sealedAt: string;
  actionDigest: string;
  manifestDigest: string;
};
export type UploadedArtefact = Omit<Artefact, "ordinal">;
export type ArtefactMediaType = "application/pdf" | "image/png" | "image/jpeg" | "image/webp";

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

  constructor(status: number) {
    super("The Mayi service rejected the request");
    this.name = "MayiHttpError";
    this.status = status;
  }
}

export class MayiResponseError extends Error {
  constructor() {
    super("The Mayi service returned an invalid response");
    this.name = "MayiResponseError";
  }
}

type AuthMode = "cookie" | "optional-access-token" | "required-access-token";

function normalizeOrigin(origin: string): string {
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

export class MayiClient {
  readonly approvals: { request: (input: ApprovalRequest, options: ApprovalRequestOptions) => Promise<PendingApproval> };

  private readonly origin: string;
  private readonly getAccessToken: GetAccessToken | undefined;
  private readonly fetch: MayiFetch;

  constructor(options: MayiClientOptions) {
    if (!options || typeof options !== "object") throw new MayiConfigurationError();
    this.origin = normalizeOrigin(options.origin);
    this.getAccessToken = options.getAccessToken;
    this.fetch = options.fetch ?? defaultFetch();
    if (typeof this.fetch !== "function") throw new MayiConfigurationError("A valid fetch implementation is required");

    this.approvals = {
      request: (input, requestOptions) => this.requestApproval(input, requestOptions),
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

    if (auth !== "cookie") {
      const token = await this.accessToken(auth === "required-access-token");
      if (token) headers.set("authorization", `Bearer ${token}`);
    }
    if (typeof init.body === "string" && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    let response: Response;
    try {
      response = await this.fetch(new URL(path, this.origin), { ...init, headers, credentials: "include" });
    } catch {
      throw new MayiNetworkError();
    }

    if (!response.ok) throw new MayiHttpError(response.status);
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
