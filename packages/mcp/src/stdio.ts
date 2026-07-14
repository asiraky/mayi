#!/usr/bin/env node
import { createInterface } from "node:readline";

const url = new URL("/api/mcp", process.env.MAYI_URL ?? "http://localhost:3000");
const token = process.env.MAYI_TOKEN;
if (!token) { process.stderr.write("MAYI_TOKEN is required\n"); process.exit(2); }

const lines = createInterface({ input: process.stdin, terminal: false });
for await (const line of lines) {
  if (!line.trim()) continue;
  try {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: line });
    process.stdout.write(`${await response.text()}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: error instanceof Error ? error.message : "Transport error" } })}\n`);
  }
}
