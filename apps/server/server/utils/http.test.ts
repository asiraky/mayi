import { describe, expect, it, vi } from "vitest";
import type { H3Event } from "h3";
import { readBoundedBody, readBoundedJsonBody, readBoundedJsonOrFormBody, readBoundedStream } from "./http";

function chunkedBody(chunks: number[][], cancel = vi.fn()) {
  let index = 0;
  return {
    cancel,
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(new Uint8Array(chunk));
        else controller.close();
      },
      cancel,
    }),
  };
}

function eventWithBody(stream: ReadableStream<Uint8Array>, contentLength?: string): H3Event {
  return {
    method: "POST",
    node: { req: { headers: contentLength === undefined ? {} : { "content-length": contentLength } } },
    web: { request: { body: stream } },
  } as unknown as H3Event;
}

describe("readBoundedStream", () => {
  it("accepts a body exactly at the byte boundary", async () => {
    const { stream, cancel } = chunkedBody([[1, 2], [3, 4]]);
    await expect(readBoundedStream(stream, 4)).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels a chunked body as soon as it crosses the boundary", async () => {
    const { stream, cancel } = chunkedBody([[1, 2], [3, 4], [5], [6]]);
    await expect(readBoundedStream(stream, 4, "bounded body exceeded"))
      .rejects.toMatchObject({ statusCode: 413, statusMessage: "bounded body exceeded" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("counts UTF-8 bytes supplied by the stream without retaining rejected content", async () => {
    const bytes = new TextEncoder().encode("éé");
    const { stream, cancel } = chunkedBody([[...bytes.subarray(0, 2)], [...bytes.subarray(2)]]);
    await expect(readBoundedStream(stream, 3)).rejects.toMatchObject({ statusCode: 413 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an oversized declared length before reading", async () => {
    const getReader = vi.fn();
    const stream = { getReader } as unknown as ReadableStream<Uint8Array>;
    await expect(readBoundedBody(eventWithBody(stream, "5"), 4))
      .rejects.toMatchObject({ statusCode: 413 });
    expect(getReader).not.toHaveBeenCalled();
  });

  it("does not trust a false small Content-Length", async () => {
    const { stream, cancel } = chunkedBody([[1, 2], [3, 4], [5]]);
    await expect(readBoundedBody(eventWithBody(stream, "1"), 4))
      .rejects.toMatchObject({ statusCode: 413 });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("readBoundedJsonBody", () => {
  it("parses JSON at the configured byte boundary", async () => {
    const bytes = [...new TextEncoder().encode('{"ok":true}')];
    const { stream } = chunkedBody([bytes.slice(0, 4), bytes.slice(4)]);
    await expect(readBoundedJsonBody(eventWithBody(stream), bytes.length)).resolves.toEqual({ ok: true });
  });

  it("rejects malformed and oversized chunked JSON", async () => {
    const malformed = chunkedBody([[123]]);
    await expect(readBoundedJsonBody(eventWithBody(malformed.stream), 10))
      .rejects.toMatchObject({ statusCode: 400 });

    const oversized = chunkedBody([[123, 34], [120, 34, 58, 49, 125]]);
    await expect(readBoundedJsonBody(eventWithBody(oversized.stream), 4))
      .rejects.toMatchObject({ statusCode: 413 });
    expect(oversized.cancel).toHaveBeenCalledOnce();
  });
});

describe("readBoundedJsonOrFormBody", () => {
  it("parses bounded OAuth form data", async () => {
    const encoded = [...new TextEncoder().encode("decision=approve&scope=approval%3Aread")];
    const { stream } = chunkedBody([encoded]);
    const event = eventWithBody(stream) as H3Event & { node: { req: { headers: Record<string, string> } } };
    event.node.req.headers["content-type"] = "application/x-www-form-urlencoded";
    await expect(readBoundedJsonOrFormBody(event, encoded.length)).resolves.toEqual({
      decision: "approve",
      scope: "approval:read",
    });
  });

  it("rejects chunked OAuth form data immediately over its limit", async () => {
    const oversized = chunkedBody([[1, 2], [3, 4, 5]]);
    await expect(readBoundedJsonOrFormBody(eventWithBody(oversized.stream), 4))
      .rejects.toMatchObject({ statusCode: 413 });
    expect(oversized.cancel).toHaveBeenCalledOnce();
  });
});
