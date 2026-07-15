import { createError } from "h3";
import type { DatabaseSql } from "@mayi/db";
import type { AgentAuth } from "./auth";
import { validatePublicHttpsUrl, type ValidatePublicHttpsUrlOptions, type ValidatedPublicUrl } from "./public-url";
import { database } from "./runtime";

export type ApprovalCallbackUriLoader = (clientId: string) => Promise<readonly string[]>;

async function loadApprovalCallbackUris(clientId: string, sql: DatabaseSql = database().sql): Promise<readonly string[]> {
  const rows = await sql`select approval_callback_uris from oauth_clients where id = ${clientId}`;
  return rows.length === 1 ? rows[0]!.approval_callback_uris as string[] : [];
}

export async function authorizeApprovalCallback(
  auth: AgentAuth,
  callbackUrl: string,
  options: ValidatePublicHttpsUrlOptions & { loadUris?: ApprovalCallbackUriLoader } = {},
): Promise<ValidatedPublicUrl> {
  if (!auth.clientId) {
    throw createError({ statusCode: 403, statusMessage: "OAuth client-bound agent authentication is required for approval callbacks" });
  }

  const registered = await (options.loadUris ?? loadApprovalCallbackUris)(auth.clientId);
  // Intentionally compare the original strings. URL normalization, prefixes, path
  // suffixes, and wildcards must never broaden a client's callback authority.
  if (!registered.includes(callbackUrl)) {
    throw createError({ statusCode: 403, statusMessage: "Approval callback URL is not registered for this OAuth client" });
  }

  try {
    return await validatePublicHttpsUrl(callbackUrl, options);
  } catch (error) {
    throw createError({
      statusCode: 422,
      statusMessage: error instanceof Error ? error.message : "Approval callback URL is not a public HTTPS URL",
    });
  }
}
