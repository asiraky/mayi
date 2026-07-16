import { afterEach, describe, expect, it } from "vitest";
import { database } from "./runtime";

const globals = globalThis as { __mayiRequestDatabase?: { getStore(): unknown } };

describe("database", () => {
  afterEach(() => {
    delete globals.__mayiRequestDatabase;
  });

  it("prefers the per-request client provided by the Cloudflare worker entry", () => {
    const perRequest = { marker: "per-request" };
    globals.__mayiRequestDatabase = { getStore: () => perRequest };
    expect(database()).toBe(perRequest);
  });

  it("ignores the per-request store outside of a request scope", () => {
    globals.__mayiRequestDatabase = { getStore: () => undefined };
    // Outside a request the store is empty, so resolution falls through to the
    // process-wide client; with no DATABASE_URL configured that constructor
    // throws rather than returning a cross-request client.
    delete process.env.DATABASE_URL;
    expect(() => database()).toThrow("DATABASE_URL is required");
  });
});
