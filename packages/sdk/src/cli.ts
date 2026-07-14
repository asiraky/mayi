#!/usr/bin/env node
import { MayIClient } from "./index";

const [command, id] = process.argv.slice(2);
const origin = process.env.MAYI_URL ?? "http://localhost:3000";
const token = process.env.MAYI_TOKEN;
if (!token) { console.error("MAYI_TOKEN is required"); process.exit(2); }
const client = new MayIClient(origin, token);

if (command === "get" && id) console.log(JSON.stringify(await client.approval(id), null, 2));
else if (command === "cancel" && id) console.log(JSON.stringify(await client.cancel(id), null, 2));
else if (command === "list") console.log(JSON.stringify(await client.approvals(), null, 2));
else {
  console.error("Usage: mayi list | mayi get <id> | mayi cancel <id>");
  process.exit(2);
}
