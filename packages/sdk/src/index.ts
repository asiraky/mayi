import { createId, type Approval, type CreateApproval, type Decision, type Session } from "@mayi/contracts";

/*
 * Thrown for any non-2xx response. It stays an Error, so existing `catch (e)` code that
 * reads `.message` keeps working — but the message is now the reason rather than the
 * category.
 *
 * The server answers a failed validation with statusMessage "Invalid request" and puts
 * the actual cause in data.fieldErrors. Surfacing only the former told every caller that
 * something was wrong and never what, which is indistinguishable from a bug in the
 * caller's own code. `fieldErrors` is kept structured for callers that want to mark up
 * individual inputs.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string[]>;

  constructor(message: string, status: number, fieldErrors: Record<string, string[]> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export class MayIClient {
  constructor(private readonly origin: string, private readonly token?: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(new URL(path, this.origin), { ...init, headers, credentials: "include" });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        statusMessage?: string;
        message?: string;
        data?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] };
      };
      const fieldErrors = body.data?.fieldErrors ?? {};
      // Field messages first: "Include a special character." beats "Invalid request".
      const reasons = [...Object.values(fieldErrors).flat(), ...(body.data?.formErrors ?? [])];
      const message = reasons.length
        ? reasons.join(" ")
        : (body.statusMessage ?? body.message ?? `${response.status} ${response.statusText}`);
      throw new ApiError(message, response.status, fieldErrors);
    }
    return response.json() as Promise<T>;
  }

  signup(input: { email: string; password: string; displayName: string; bootstrapSecret?: string }) { return this.request<Session>("/api/auth/signup", { method: "POST", body: JSON.stringify(input) }); }
  signin(input: { email: string; password: string }) { return this.request<Session>("/api/auth/signin", { method: "POST", body: JSON.stringify(input) }); }
  session() { return this.request<Session>("/api/auth/session"); }
  signout() { return this.request<{ ok: true }>("/api/auth/signout", { method: "POST" }); }
  stepUp(input: { email: string; password: string }) { return this.request<{ ok: true }>("/api/auth/step-up", { method: "POST", body: JSON.stringify(input) }); }
  approvals(state?: string) { return this.request<Approval[]>(`/api/approvals${state ? `?state=${encodeURIComponent(state)}` : ""}`); }
  approval(id: string) { return this.request<Approval>(`/api/approvals/${id}`); }
  createApproval(input: CreateApproval, idempotencyKey = createId()) { return this.request<Approval>("/api/approvals", { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(input) }); }
  sealApproval(id: string, artefactIds: string[]) { return this.request<Approval>(`/api/approvals/${id}/seal`, { method: "POST", body: JSON.stringify({ artefactIds }) }); }
  decide(id: string, input: Decision) { return this.request<Approval>(`/api/approvals/${id}/decision`, { method: "POST", body: JSON.stringify(input) }); }
  cancel(id: string) { return this.request<Approval>(`/api/approvals/${id}/cancel`, { method: "POST" }); }
  activity() { return this.request<Array<Record<string, unknown>>>("/api/activity"); }
  agents() { return this.request<Array<Record<string, unknown>>>("/api/agents"); }
  createAgent(input: { name: string; scopes: string[] }) { return this.request<{ id: string; token: string }>("/api/agents", { method: "POST", body: JSON.stringify(input) }); }
  registerDevice(token: string, platform: "ios" | "android") { return this.request<{ ok: true }>("/api/devices", { method: "POST", body: JSON.stringify({ token, platform }) }); }
}
