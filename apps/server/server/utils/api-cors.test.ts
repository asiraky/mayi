import { createApp, createRouter, toWebHandler } from "h3";
import { describe, expect, it, vi } from "vitest";
import corsPreflight from "../middleware/01.api-cors";

describe("API CORS preflight", () => {
  it("terminates a bearer/custom-header preflight before route dispatch", async () => {
    const route = vi.fn(() => ({ reached: true }));
    const router = createRouter().post("/api/approvals/request", route);
    const app = createApp();
    app.use(corsPreflight);
    app.use(router);
    const response = await toWebHandler(app)(new Request("http://mayi.test/api/approvals/request", {
      method: "OPTIONS",
      headers: {
        origin: "https://consumer.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,idempotency-key,x-mayi-filename",
      },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(response.headers.get("access-control-allow-headers")).toContain("idempotency-key");
    expect(route).not.toHaveBeenCalled();
  });

  it("does not intercept non-API OPTIONS requests", async () => {
    const route = vi.fn(() => ({ reached: true }));
    const router = createRouter().options("/other", route);
    const app = createApp();
    app.use(corsPreflight);
    app.use(router);
    const response = await toWebHandler(app)(new Request("http://mayi.test/other", { method: "OPTIONS" }));
    expect(response.status).toBe(200);
    expect(route).toHaveBeenCalledOnce();
  });
});
