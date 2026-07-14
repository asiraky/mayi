import { defineEventHandler } from "h3";
import { getConfig } from "../../utils/config";
export default defineEventHandler(() => ({ resource: `${getConfig().publicOrigin}/api/mcp`, authorization_servers: [getConfig().publicOrigin], bearer_methods_supported: ["header"], scopes_supported: ["approval:create", "approval:read", "approval:cancel"] }));
