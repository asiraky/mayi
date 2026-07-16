import { defineEventHandler, sendRedirect } from "h3";
import { readBoundedJsonOrFormBody } from "../../utils/http";
import { revokeSession } from "../../utils/auth";

/*
 * Only same-origin paths are redirect targets: a leading single slash, no
 * backslashes (browsers normalize them to slashes, turning "/\evil.com" into a
 * protocol-relative URL). Control characters are rejected too: the WHATWG URL
 * parser strips tab/newline before resolving, so "/\t/evil.com" would become
 * protocol-relative, and CR/LF in a Location value can throw or inject headers.
 * Anything else falls back to the JSON response.
 */
function localPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return value;
}

export default defineEventHandler(async (event) => {
  // The SDK posts no body; the consent page posts a returnTo form field. An
  // absent or malformed body simply means "no redirect", never an error.
  const body = await readBoundedJsonOrFormBody(event).catch(() => undefined);
  await revokeSession(event);
  const returnTo = localPath(body?.returnTo);
  if (returnTo) return sendRedirect(event, returnTo, 303);
  return { ok: true };
});
