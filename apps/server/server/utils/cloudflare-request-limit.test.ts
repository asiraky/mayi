import { describe, expect, it } from "vitest";
import { boundCloudflareRequest, cloudflareRequestBodyLimit } from "../../../../deploy/bounded-request";

function streamedRequest(path: string, chunks: Uint8Array[]): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  return new Request(`https://app.mayi.sh${path}`, {
    method: "POST", body, duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("Cloudflare entry request limits", () => {
  it("uses endpoint-specific limits before Nitro buffering", () => {
    expect(cloudflareRequestBodyLimit(new Request("https://app.mayi.sh/api/oauth/consent", { method: "POST" }))).toBe(32 * 1024);
    expect(cloudflareRequestBodyLimit(new Request("https://app.mayi.sh/api/receipts/consume", { method: "POST" }))).toBe(128 * 1024);
    expect(cloudflareRequestBodyLimit(new Request("https://app.mayi.sh/api/approvals/request/artefacts/0", { method: "POST" }))).toBe(25 * 1024 * 1024);
    expect(cloudflareRequestBodyLimit(new Request("https://app.mayi.sh/api/activity", { method: "POST" }))).toBe(1024 * 1024);
  });

  it("reconstructs an in-limit body for Nitro", async () => {
    const request = streamedRequest("/api/oauth/consent", [new Uint8Array([1, 2]), new Uint8Array([3])]);
    const bounded = await boundCloudflareRequest(request);
    expect(bounded).toBeInstanceOf(Request);
    await expect((bounded as Request).arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
  });

  it("returns 413 as soon as a chunked route body crosses its edge limit", async () => {
    const bounded = await boundCloudflareRequest(streamedRequest("/api/oauth/consent", [
      new Uint8Array(32 * 1024), new Uint8Array([1]), new Uint8Array([2]),
    ]));
    expect(bounded).toBeInstanceOf(Response);
    expect((bounded as Response).status).toBe(413);
    expect((bounded as Response).headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects OPTIONS bodies and bounds unmatched routes before Nitro", async () => {
    const options = await boundCloudflareRequest(new Request("https://app.mayi.sh/api/oauth/consent", {
      method: "OPTIONS", body: "x",
    }));
    expect(options).toBeInstanceOf(Response);
    expect((options as Response).status).toBe(413);

    const unmatched = await boundCloudflareRequest(streamedRequest("/not-a-route", [
      new Uint8Array(1024 * 1024), new Uint8Array([1]),
    ]));
    expect(unmatched).toBeInstanceOf(Response);
    expect((unmatched as Response).status).toBe(413);
  });

  it("rejects a declared oversize before reading the stream", async () => {
    const request = new Request("https://app.mayi.sh/api/oauth/token", {
      method: "POST", headers: { "content-length": String(32 * 1024 + 1) }, body: "x",
    });
    const bounded = await boundCloudflareRequest(request);
    expect(bounded).toBeInstanceOf(Response);
    expect((bounded as Response).status).toBe(413);
  });
});
