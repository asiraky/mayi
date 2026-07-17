import { CALLBACK_ACCEPTANCE_WINDOW_SECONDS, createCallbackStateCodec, type MayiFetch } from "@mayiapp/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createInputRequestedHandler,
  createMayiIdempotencyKey,
  createRuntime,
  mayiChannel,
  type EveInputRequest,
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

function questionRequest(requestId: string, shape: {
  display?: "confirmation" | "select" | "text";
  options?: { id: string; label?: string; description?: string; style?: "danger" | "default" | "primary" }[];
  allowFreeform?: boolean;
}): EveInputRequest {
  return {
    action: {
      kind: "tool-call" as const,
      toolName: "ask_question",
      callId: `${requestId}-call`,
      input: {},
    },
    prompt: "Which rollout option?",
    requestId,
    ...shape,
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

function pendingInput(request: {
  type: "text" | "select" | "confirmation";
  prompt: string;
  options?: { id: string; label: string }[];
  allowFreeform?: boolean;
}) {
  return {
    id: "InputAbcdefg",
    type: request.type,
    prompt: request.prompt,
    options: request.options ?? null,
    allowFreeform: request.allowFreeform ?? false,
    state: "PENDING",
    answer: null,
    attestation: null,
    respondentId: null,
    agentId: "AgentAbcdefg",
    createdAt: "2026-07-15T00:00:00.000Z",
    expiresAt: "2026-07-15T01:00:00.000Z",
    answeredAt: null,
    cancelledAt: null,
  };
}

function createFetchMock() {
  return vi.fn<MayiFetch>(async (input, init) => {
    const request = JSON.parse(String(init?.body)) as Parameters<typeof pendingInput>[0]
      & { action: unknown; explanation: string };
    if (String(input).endsWith("/api/inputs")) return Response.json(pendingInput(request));
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

  it("joins the callback path onto a path-bearing public base URL", async () => {
    const fetchMock = createFetchMock();
    const callbackStateCodec = await createCallbackStateCodec({
      currentKey: { kid: "test-key", key: callbackKey },
      maximumRetryWindowSeconds: CALLBACK_ACCEPTANCE_WINDOW_SECONDS,
      now: () => now,
    });
    const pathRoutedRuntime = createRuntime({
      getAccessToken: async () => "fabricated-oauth-token",
      mayiOrigin: "https://mayi.example",
      callbackStateCodec,
      environment: { EVE_PUBLIC_ORIGIN: "https://eden.example/e/abc123def456" },
      fetch: fetchMock,
    }, { now: () => now });
    const handler = createInputRequestedHandler(pathRoutedRuntime);
    const state: MayiChannelState = {
      rawContinuationToken: "mayi:raw-continuation-secret",
      target: {},
    };

    await handler(
      { requests: [approvalRequest("call-one", "request-one")] },
      { state },
      { session: { id: "eve-session-one" } },
    );

    const [call] = capturedCalls(fetchMock);
    expect(call!.body.callback.url)
      .toBe(`https://eden.example/e/abc123def456${MAYI_CALLBACK_PATH}`);
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

  it("routes a text ask through the generic inputs API with the sealed continuation state", async () => {
    const fetchMock = createFetchMock();
    const fixture = await runtime(fetchMock);
    const handler = createInputRequestedHandler(fixture.runtime);
    const request = questionRequest("question-request", { display: "text" });

    await handler({ requests: [request] }, {
      state: { rawContinuationToken: "mayi:durable-token", target: { mayiUserId: "ApproverAbcd" } },
    }, { session: { id: "eve-session-one" } });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://mayi.example/api/inputs");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { callback: { state: string; url: string } };
    expect(body).toMatchObject({
      type: "text",
      prompt: "Which rollout option?",
      expiresInSeconds: 3_600,
      suggestedApproverId: "ApproverAbcd",
    });
    expect(body).not.toHaveProperty("options");
    expect(body).not.toHaveProperty("allowFreeform");
    expect(body).not.toHaveProperty("action");
    expect(body.callback.url).toBe(`https://agent.example${MAYI_CALLBACK_PATH}`);
    expect(new Headers(init?.headers).get("idempotency-key"))
      .toBe(await createMayiIdempotencyKey("eve-session-one", "question-request"));
    await expect(fixture.callbackStateCodec.open<MayiContinuationStateV1>(body.callback.state))
      .resolves.toMatchObject({
        version: 1,
        rawContinuationToken: "mayi:durable-token",
        requestId: "question-request",
        sessionId: "eve-session-one",
      });
  });

  it("maps a select ask with labels, descriptions, styles, and freeform through unchanged", async () => {
    const fetchMock = createFetchMock();
    const fixture = await runtime(fetchMock);
    const handler = createInputRequestedHandler(fixture.runtime);
    const request = questionRequest("question-request", {
      display: "select",
      allowFreeform: true,
      options: [
        { id: "blue", label: "Blue", description: "The calm one", style: "primary" },
        { id: "red" },
      ],
    });

    await handler({ requests: [request] }, {
      state: { rawContinuationToken: "mayi:durable-token", target: {} },
    }, { session: { id: "eve-session-one" } });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://mayi.example/api/inputs");
    expect(body).toMatchObject({
      type: "select",
      prompt: "Which rollout option?",
      allowFreeform: true,
      options: [
        { id: "blue", label: "Blue", description: "The calm one", style: "primary" },
        { id: "red", label: "red" },
      ],
    });
  });

  it("maps a non-approval confirmation to a confirmation input, or a select when not two options", async () => {
    const fetchMock = createFetchMock();
    const fixture = await runtime(fetchMock);
    const handler = createInputRequestedHandler(fixture.runtime);

    await handler({ requests: [questionRequest("question-one", {
      display: "confirmation",
      options: [{ id: "ship", label: "Ship" }, { id: "hold" }],
    })] }, {
      state: { rawContinuationToken: "mayi:durable-token", target: {} },
    }, { session: { id: "eve-session-one" } });
    await handler({ requests: [questionRequest("question-two", {
      display: "confirmation",
      options: [{ id: "ship" }, { id: "hold" }, { id: "abort" }],
    })] }, {
      state: { rawContinuationToken: "mayi:durable-token", target: {} },
    }, { session: { id: "eve-session-one" } });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({
      type: "confirmation",
      options: [{ id: "ship", label: "Ship" }, { id: "hold", label: "hold" }],
    });
    expect(bodies[1]).toMatchObject({
      type: "select",
      options: [{ id: "ship", label: "ship" }, { id: "hold", label: "hold" }, { id: "abort", label: "abort" }],
    });
  });

  it("maps a freeform confirmation to a select input so the typed answer path survives", async () => {
    const fetchMock = createFetchMock();
    const fixture = await runtime(fetchMock);
    const handler = createInputRequestedHandler(fixture.runtime);

    await handler({ requests: [questionRequest("question-one", {
      display: "confirmation",
      allowFreeform: true,
      options: [{ id: "ship", label: "Ship" }, { id: "hold" }],
    })] }, {
      state: { rawContinuationToken: "mayi:durable-token", target: {} },
    }, { session: { id: "eve-session-one" } });

    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://mayi.example/api/inputs");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: "select",
      allowFreeform: true,
      options: [{ id: "ship", label: "Ship" }, { id: "hold", label: "hold" }],
    });
  });

  it("maps a select or confirmation ask without options to a text input", async () => {
    const fetchMock = createFetchMock();
    const fixture = await runtime(fetchMock);
    const handler = createInputRequestedHandler(fixture.runtime);

    await handler({ requests: [questionRequest("question-one", {
      display: "select",
      options: [],
    })] }, {
      state: { rawContinuationToken: "mayi:durable-token", target: {} },
    }, { session: { id: "eve-session-one" } });
    await handler({ requests: [questionRequest("question-two", {
      display: "confirmation",
    })] }, {
      state: { rawContinuationToken: "mayi:durable-token", target: {} },
    }, { session: { id: "eve-session-one" } });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    for (const body of bodies) {
      expect(body).toMatchObject({ type: "text", prompt: "Which rollout option?" });
      expect(body).not.toHaveProperty("options");
      expect(body).not.toHaveProperty("allowFreeform");
    }
  });

  it("keeps routing approval-shaped confirmations through the receipts-minting approvals API", async () => {
    const fetchMock = createFetchMock();
    const fixture = await runtime(fetchMock);
    const handler = createInputRequestedHandler(fixture.runtime);
    const approval = approvalRequest("call-one", "request-one");
    const question = questionRequest("question-request", { display: "text" });

    await handler({ requests: [approval, question] }, {
      state: { rawContinuationToken: "mayi:durable-token", target: {} },
    }, { session: { id: "eve-session-one" } });

    const byUrl = new Map(fetchMock.mock.calls.map(([url, init]) => [
      String(url),
      JSON.parse(String(init?.body)) as Record<string, unknown>,
    ]));
    expect([...byUrl.keys()].sort()).toEqual([
      "https://mayi.example/api/approvals/request",
      "https://mayi.example/api/inputs",
    ]);
    const approvalBody = byUrl.get("https://mayi.example/api/approvals/request")!;
    expect(approvalBody).toMatchObject({ action: approval.action, explanation: approval.prompt });
    expect(approvalBody).not.toHaveProperty("type");
    expect(byUrl.get("https://mayi.example/api/inputs")).toMatchObject({ type: "text" });
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
