import { compactVerify, importJWK } from "jose";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { describe, expect, it, vi } from "vitest";
import { canonicalize } from "@mayi/contracts";
import {
  deliverForwardingHttpNode,
  signWebhook,
  validateOutboundUrl,
  type NodeForwardingRequest,
} from "./forwarding";
import { signingKeys } from "./signer";

function respondingRequest(status: number, responseBody = ""): {
  request: NodeForwardingRequest;
  calls: RequestOptions[];
} {
  const calls: RequestOptions[] = [];
  const request: NodeForwardingRequest = (options, callback) => {
    calls.push(options);
    const req = new EventEmitter() as ClientRequest;
    req.destroy = (() => req) as ClientRequest["destroy"];
    req.end = (() => {
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
      response.setTimeout = (() => response) as IncomingMessage["setTimeout"];
      callback(response);
      stream.end(responseBody);
      return req;
    }) as ClientRequest["end"];
    return req;
  };
  return { request, calls };
}

describe("forwarding security", () => {
  it("rejects private and insecure callback targets", async () => {
    await expect(validateOutboundUrl("http://example.com/hook")).rejects.toThrow(/HTTPS/);
    await expect(validateOutboundUrl("https://127.0.0.1/hook")).rejects.toThrow(/public/);
    await expect(validateOutboundUrl("https://service.local/hook")).rejects.toThrow(/public/);
  });

  it("connects to the validation-time address while preserving Host and TLS SNI", async () => {
    let lookups = 0;
    const target = await validateOutboundUrl("https://hooks.example/deliver?tenant=one", {
      resolve: async () => {
        lookups++;
        return lookups === 1 ? ["8.8.8.8"] : ["127.0.0.1"];
      },
    });
    const transport = respondingRequest(202, "accepted");

    const response = await deliverForwardingHttpNode(target, {
      body: "{}",
      headers: { "content-type": "application/json" },
    }, { request: transport.request, isIP: () => 0 });

    expect(response).toMatchObject({ status: 202 });
    expect(new TextDecoder().decode(response.body)).toBe("accepted");
    expect(lookups).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({
      hostname: "8.8.8.8",
      servername: "hooks.example",
      path: "/deliver?tenant=one",
      headers: { host: "hooks.example", "content-length": 2 },
    });
  });

  it("returns redirects to the caller without following their Location", async () => {
    const target = await validateOutboundUrl("https://hooks.example/deliver", {
      resolve: async () => ["8.8.8.8"],
    });
    const transport = respondingRequest(302);
    const response = await deliverForwardingHttpNode(target, { body: "{}" }, {
      request: transport.request,
      isIP: () => 0,
    });
    expect(response.status).toBe(302);
    expect(transport.calls).toHaveLength(1);
  });

  it("bounds connection establishment before the outbox lease can expire", async () => {
    vi.useFakeTimers();
    try {
      const target = await validateOutboundUrl("https://hooks.example/deliver", {
        resolve: async () => ["8.8.8.8"],
      });
      const request: NodeForwardingRequest = () => {
        const req = new EventEmitter() as ClientRequest;
        req.destroy = (() => req) as ClientRequest["destroy"];
        req.end = (() => req) as ClientRequest["end"];
        return req;
      };
      const delivery = deliverForwardingHttpNode(target, { body: "{}" }, {
        request,
        isIP: () => 0,
        connectTimeoutMs: 25,
        totalTimeoutMs: 100,
      });
      const assertion = expect(delivery).rejects.toThrow(/connection timed out/);
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("signs the exact canonical webhook payload", async () => {
    const payload = { z: 2, a: "request" };
    const signature = await signWebhook(payload);
    const key = await importJWK((await signingKeys()).publicJwk, "EdDSA");
    const verified = await compactVerify(signature, key);
    expect(new TextDecoder().decode(verified.payload)).toBe(canonicalize(payload));
  });
});
