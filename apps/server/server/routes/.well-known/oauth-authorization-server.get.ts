import { defineEventHandler } from "h3";
import { getConfig } from "../../utils/config";
export default defineEventHandler(() => {
  const origin = getConfig().publicOrigin;
  return { issuer: origin, authorization_endpoint: `${origin}/api/oauth/authorize`, token_endpoint: `${origin}/api/oauth/token`, registration_endpoint: `${origin}/api/oauth/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["approval:create", "approval:read", "approval:cancel"] };
});
