#!/usr/bin/env node
import type { Approval } from "@mayi/contracts";
import { MayiClient } from "./index";

const [command, id] = process.argv.slice(2);
const origin = process.env.MAYI_URL ?? "http://localhost:3000";
if (!process.env.MAYI_ACCESS_TOKEN) { console.error("MAYI_ACCESS_TOKEN is required"); process.exit(2); }
const client = new MayiClient({
  origin,
  getAccessToken: async () => process.env.MAYI_ACCESS_TOKEN ?? "",
});

function summary(approval: Approval) {
  return {
    id: approval.id,
    state: approval.state,
    createdAt: approval.createdAt,
    sealedAt: approval.sealedAt,
    expiresAt: approval.expiresAt,
    decidedAt: approval.decidedAt,
  };
}

if (command === "get" && id) console.log(JSON.stringify(summary(await client.approval(id)), null, 2));
else if (command === "cancel" && id) console.log(JSON.stringify(summary(await client.cancel(id)), null, 2));
else if (command === "list") console.log(JSON.stringify((await client.listApprovals()).map(summary), null, 2));
else {
  console.error("Usage: mayi list | mayi get <id> | mayi cancel <id>");
  process.exit(2);
}
