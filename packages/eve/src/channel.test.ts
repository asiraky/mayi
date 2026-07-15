import { createCallbackStateCodec, type MayiFetch } from "@mayi/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createInputRequestedHandler,
  createMayiIdempotencyKey,
  createRuntime,
  mayiChannel,
  UnsupportedMayiInputError,
  type MayiChannelState,
  type MayiContinuationStateV1,
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
    maximumRetryWindowSeconds: 3_833,
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
          expiresAt: "2026-07-15T02:03:53.000Z",
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
    await expect(promise).rejects.toBeInstanceOf(UnsupportedMayiInputError);
    await expect(promise).rejects.toThrow(/supports only tool approval confirmations/u);
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
    await expect(handler({ requests: [approvalRequest("call-one", "request-one")] }, {
      state: { rawContinuationToken: "mayi:durable-token", target: {} },
    }, { session: { id: "eve-session-one" } })).rejects.toMatchObject({ code: "PUBLIC_ORIGIN_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
