import { CALLBACK_ACCEPTANCE_WINDOW_SECONDS, createCallbackStateCodec, type MayiFetch } from "@mayiapp/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createInputRequestedHandler,
  createMayiIdempotencyKey,
  createRuntime,
  mayiChannel,
  UnsupportedMayiInputError,
  type MayiChannelState,
  type MayiContinuationStateV1,
  type MayiArtefactsContext,
} from "./channel";
import { MAYI_CALLBACK_PATH } from "./origin";

const now = Date.parse("2026-07-15T00:00:00.000Z");
const callbackKey = new Uint8Array(32).fill(7);

function approvalRequest(callId: string, requestId: string) {
  return {
    action: {
      kind: "tool-call" as const,
      toolName: "deploy_release",
      callId,
      input: { environment: "production", release: callId },
    },
    display: "confirmation" as const,
    options: [
      { id: "approve", label: "Approve" },
      { id: "deny", label: "Deny" },
    ],
    prompt: `Deploy ${callId}?`,
    requestId,
  };
}

function pendingApproval(action: unknown, explanation: string) {
  return {
    id: "ApprovalAbcd",
    workspaceId: "WorkspaceAbc",
    agentId: "AgentAbcdefg",
    state: "PENDING",
    action,
    explanation,
    enforcement: "cooperative",
    actionDigest: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    artefacts: [],
    createdAt: "2026-07-15T00:00:00.000Z",
    sealedAt: "2026-07-15T00:00:01.000Z",
    expiresAt: "2026-07-15T01:00:00.000Z",
    decidedAt: null,
    decisionComment: null,
    approverId: null,
  };
}

function createFetchMock() {
  return vi.fn<MayiFetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { action: unknown; explanation: string };
    return Response.json(pendingApproval(request.action, request.explanation));
  });
}

async function runtime(fetch: MayiFetch) {
  const callbackStateCodec = await createCallbackStateCodec({
    currentKey: { kid: "test-key", key: callbackKey },
    maximumRetryWindowSeconds: CALLBACK_ACCEPTANCE_WINDOW_SECONDS,
    now: () => now,
  });
  return {
    callbackStateCodec,
    runtime: createRuntime({
      getAccessToken: async () => "fabricated-oauth-token",
      mayiOrigin: "https://mayi.example",
      publicOrigin: "https://agent.example",
      callbackStateCodec,
      environment: { NODE_ENV: "test" },
      fetch,
    }, { now: () => now }),
  };
}

function capturedCalls(fetchMock: ReturnType<typeof createFetchMock>) {
  return fetchMock.mock.calls.map(([, init]) => ({
    body: JSON.parse(String(init?.body)) as {
      action: ReturnType<typeof approvalRequest>["action"];
      callback: { state: string; url: string };
      explanation: string;
      suggestedApproverId?: string;
    },
    idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
  }));
}

describe("mayiChannel", () => {
  it("requires both durable event-store hooks when a host opts in", () => {
    expect(() => mayiChannel({
      getAccessToken: async () => "token",
      eventStore: { isProcessed: async () => false } as never,
    })).toThrow(/both isProcessed and markProcessed/u);
    expect(() => mayiChannel({
      getAccessToken: async () => "token",
      eventStore: { markProcessed: async () => undefined } as never,
    })).toThrow(/both isProcessed and markProcessed/u);
  });

  it("registers exactly the hosted callback route and rejects unsigned callbacks", async () => {
    const channel = mayiChannel({
      getAccessToken: async () => "token",
      fetch: createFetchMock(),
      environment: {},
    });

    expect(channel.routes).toHaveLength(1);
    expect(channel.routes[0]).toMatchObject({ method: "POST", path: MAYI_CALLBACK_PATH });
    const route = channel.routes[0]!;
    if (route.transport === "websocket") throw new Error("Expected an HTTP callback route");
    const response = await route.handler(new Request(`https://agent.example${MAYI_CALLBACK_PATH}`, {
      method: "POST",
    }), {} as never);
    expect(response.status).toBe(401);
  });

  it("generates and durably seeds a channel-local raw continuation token", async () => {
    const channel = mayiChannel({
      getAccessToken: async () => "token",
      fetch: createFetchMock(),
      environment: {},
    });
    const send = vi.fn(async (
      input: unknown,
      options: { continuationToken: string; state: MayiChannelState },
    ) => {
      void [input, options];
      return {
        id: "SessionAbcde",
        continuationToken: "raw",
        getEventStream: async () => new ReadableStream(),
      };
    });

    await channel.receive!({
      message: "Check production",
      target: { mayiUserId: "ApproverAbcd" },
      auth: null,
    }, { send: send as never });

    const [, options] = send.mock.calls[0]!;
    expect(options.continuationToken).toMatch(/^mayi:[0-9a-f-]{36}$/);
    expect(options.state).toEqual({
      rawContinuationToken: options.continuationToken,
      target: { mayiUserId: "ApproverAbcd" },
      callbackRequests: {},
    });
    expect(options.continuationToken.split(":"))
      .toHaveLength(2);
  });

  it("submits multiple approval requests independently with opaque correlation state", async () => {
    const fetchMock = createFetchMock();
    const fixture = await runtime(fetchMock);
    const handler = createInputRequestedHandler(fixture.runtime);
    const requests = [approvalRequest("call-one", "request-one"), approvalRequest("call-two", "request-two")];
    const rawContinuationToken = "mayi:raw-continuation-secret";
    const state: MayiChannelState = {
      rawContinuationToken,
      target: { mayiUserId: "ApproverAbcd" },
    };
    const inputChannel = {
      state,
      continuationToken: `channels/mayi:${rawContinuationToken}`,
    };

    await handler({ requests }, inputChannel, { session: { id: "eve-session-one" } });

    const calls = capturedCalls(fetchMock);
    expect(calls).toHaveLength(2);
    const byCallId = new Map(calls.map((call) => [call.body.action.callId, call]));
    for (const request of requests) {
      const call = byCallId.get(request.action.callId)!;
      expect(call.body.action).toEqual(request.action);
      expect(call.body.explanation).toBe(request.prompt);
      expect(call.body.suggestedApproverId).toBe("ApproverAbcd");
      expect(call.body.callback.url).toBe(`https://agent.example${MAYI_CALLBACK_PATH}`);
      expect(JSON.stringify(call.body)).not.toContain(rawContinuationToken);
      await expect(fixture.callbackStateCodec.open<MayiContinuationStateV1>(call.body.callback.state))
        .resolves.toEqual({
          version: 1,
          rawContinuationToken,
          requestId: request.requestId,
          sessionId: "eve-session-one",
          expiresAt: "2026-07-22T01:00:00.000Z",
        });
      await expect(fixture.callbackStateCodec.open<MayiContinuationStateV1>(call.body.callback.state))
        .resolves.not.toMatchObject({ rawContinuationToken: inputChannel.continuationToken });
    }
    expect(byCallId.get("call-one")!.body.callback.state)
      .not.toBe(byCallId.get("call-two")!.body.callback.state);
  });

  it("uses stable per-request idempotency keys across event retries", async () => {
    const fetchMock = createFetchMock();
    const fixture = await runtime(fetchMock);
    const handler = createInputRequestedHandler(fixture.runtime);
    const requests = [approvalRequest("call-one", "request-one"), approvalRequest("call-two", "request-two")];
    const state: MayiChannelState = {
      rawContinuationToken: "mayi:durable-token",
      target: {},
    };

    await handler({ requests }, { state }, { session: { id: "eve-session-one" } });
    await handler({ requests }, { state }, { session: { id: "eve-session-one" } });

    const keys = capturedCalls(fetchMock).map((call) => call.idempotencyKey);
    expect(keys[0]).toBe(keys[2]);
    expect(keys[1]).toBe(keys[3]);
    expect(keys[0]).not.toBe(keys[1]);
    await expect(createMayiIdempotencyKey("eve-session-one", "request-one"))
      .resolves.toBe(keys[0]);
    const bodies = capturedCalls(fetchMock).map((call) => call.body);
    expect(bodies[0]).toEqual(bodies[2]);
    expect(bodies[1]).toEqual(bodies[3]);
    expect(state.callbackRequests).toMatchObject({
      "request-one": { state: bodies[0]!.callback.state },
      "request-two": { state: bodies[1]!.callback.state },
    });
  });

  it("renders and stages approval evidence from request and session context", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const hook = vi.fn(async (context: MayiArtefactsContext) => {
      void context;
      return [{ filename: "preview.png", mediaType: "image/png" as const, body: bytes }];
    });
    const fetchMock = vi.fn<MayiFetch>(async (input, init) => {
      if (String(input).endsWith("/artefacts/0")) {
        return Response.json({
          id: "ArtefactAbcd",
          filename: "preview.png",
          mediaType: "image/png",
          size: bytes.byteLength,
          sha256: "c".repeat(64),
        });
      }
      const body = JSON.parse(String(init?.body)) as { action: unknown; explanation: string };
      return Response.json(pendingApproval(body.action, body.explanation));
    });
    const fixture = await runtime(fetchMock);
    const artefactRuntime = createRuntime({
      getAccessToken: async () => "fabricated-oauth-token",
      mayiOrigin: "https://mayi.example",
      publicOrigin: "https://agent.example",
      callbackStateCodec: fixture.callbackStateCodec,
      environment: { NODE_ENV: "test" },
      artefacts: hook,
      fetch: fetchMock,
    }, { now: () => now });
    const handler = createInputRequestedHandler(artefactRuntime);
    const request = approvalRequest("call-one", "request-one");
    const session = { id: "eve-session-one", continuationToken: "channels/mayi:token", auth: null } as never;
    const getSandbox = vi.fn(async () => ({}) as never);
    const state: MayiChannelState = { rawContinuationToken: "mayi:token", target: {} };

    await handler({ requests: [request] }, { state, session }, { session, getSandbox });
    await handler({ requests: [request] }, { state, session }, { session, getSandbox });

    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls[0]![0]).toMatchObject({ request, session });
    expect(hook.mock.calls[0]![0].getSandbox).toBe(getSandbox);
    expect(hook.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [, uploadInit] = fetchMock.mock.calls[0]!;
    expect(uploadInit?.body).toBe(bytes);
    const finalBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as Record<string, unknown>;
    expect(finalBody.artefactIds).toEqual(["ArtefactAbcd"]);
    expect(JSON.parse(String(fetchMock.mock.calls[3]![1]?.body))).toEqual(finalBody);
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("idempotency-key"))
      .toBe(new Headers(fetchMock.mock.calls[2]![1]?.headers).get("idempotency-key"));
    expect(JSON.stringify(request)).not.toContain("preview.png");
  });

  it("lets successful requests finish when another request in the Eve batch fails", async () => {
    const fetchMock = createFetchMock();
    const fixture = await runtime(fetchMock);
    const handler = createInputRequestedHandler(createRuntime({
      getAccessToken: async () => "token",
      mayiOrigin: "https://mayi.example",
      publicOrigin: "https://agent.example",
      callbackStateCodec: fixture.callbackStateCodec,
      environment: { NODE_ENV: "test" },
      artefacts: async ({ request }) => {
        if (request.requestId === "request-one") throw new Error("render failed");
        return [];
      },
      fetch: fetchMock,
    }, { now: () => now }));
    const session = { id: "eve-session-one", continuationToken: "token", auth: null } as never;
    const error = await handler({ requests: [
      approvalRequest("call-one", "request-one"),
      approvalRequest("call-two", "request-two"),
    ] }, {
      state: { rawContinuationToken: "mayi:token", target: {} },
      session,
    }, { session, getSandbox: async () => ({}) as never }).catch((cause) => cause) as AggregateError;

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(capturedCalls(fetchMock)[0]!.body.action.callId).toBe("call-two");
  });

  it.each([undefined, null, []] as const)("omits artefactIds when the hook returns %s", async (result) => {
    const fetchMock = createFetchMock();
    const fixture = await runtime(fetchMock);
    const handler = createInputRequestedHandler(createRuntime({
      getAccessToken: async () => "token",
      mayiOrigin: "https://mayi.example",
      publicOrigin: "https://agent.example",
      callbackStateCodec: fixture.callbackStateCodec,
      environment: { NODE_ENV: "test" },
      artefacts: async () => result,
      fetch: fetchMock,
    }, { now: () => now }));
    const session = { id: "eve-session-one", continuationToken: "token", auth: null } as never;
    await handler({ requests: [approvalRequest("call-one", "request-one")] }, {
      state: { rawContinuationToken: "mayi:token", target: {} },
      session,
    }, { session, getSandbox: async () => ({}) as never });
    expect(capturedCalls(fetchMock)[0]!.body).not.toHaveProperty("artefactIds");
  });

  it("times out without creating an approval when the artefact hook does not finish", async () => {
    const fetchMock = createFetchMock();
    const fixture = await runtime(fetchMock);
    let signal: AbortSignal | undefined;
    const handler = createInputRequestedHandler(createRuntime({
      getAccessToken: async () => "token",
      mayiOrigin: "https://mayi.example",
      publicOrigin: "https://agent.example",
      callbackStateCodec: fixture.callbackStateCodec,
      environment: { NODE_ENV: "test" },
      artefactTimeoutMs: 5,
      artefacts: async (context) => {
        signal = context.signal;
        return await new Promise(() => undefined);
      },
      fetch: fetchMock,
    }, { now: () => now }));
    const session = { id: "eve-session-one", continuationToken: "token", auth: null } as never;
    await expect(handler({ requests: [approvalRequest("call-one", "request-one")] }, {
      state: { rawContinuationToken: "mayi:token", target: {} },
      session,
    }, { session, getSandbox: async () => ({}) as never })).rejects.toBeInstanceOf(AggregateError);
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { display: "text" as const, allowFreeform: true },
    { display: "select" as const, options: [{ id: "blue", label: "Blue" }] },
  ])("rejects unsupported ask_question input loudly for $display", async (shape) => {
    const fetchMock = createFetchMock();
    const fixture = await runtime(fetchMock);
    const handler = createInputRequestedHandler(fixture.runtime);
    const request = {
      ...approvalRequest("question-call", "question-request"),
      ...shape,
      prompt: "Which option?",
    };

    const promise = handler({ requests: [request] }, {
      state: { rawContinuationToken: "mayi:durable-token", target: {} },
    }, { session: { id: "eve-session-one" } });
    const error = await promise.catch((cause) => cause) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0]).toBeInstanceOf(UnsupportedMayiInputError);
    expect(error.errors[0]).toHaveProperty("message", expect.stringMatching(/supports only tool approval confirmations/u));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed before calling Mayi when stable host configuration is absent", async () => {
    const fetchMock = createFetchMock();
    const handler = createInputRequestedHandler(createRuntime({
      getAccessToken: async () => "token",
      mayiOrigin: "https://mayi.example",
      callbackStateCodec: (await runtime(fetchMock)).callbackStateCodec,
      environment: {},
      fetch: fetchMock,
    }, { now: () => now }));
    const error = await handler({ requests: [approvalRequest("call-one", "request-one")] }, {
      state: { rawContinuationToken: "mayi:durable-token", target: {} },
    }, { session: { id: "eve-session-one" } }).catch((cause) => cause) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0]).toMatchObject({ code: "PUBLIC_ORIGIN_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
