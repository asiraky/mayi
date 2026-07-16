export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

export function emailConfigured(): boolean {
  return Boolean(process.env.POSTMARK_SERVER_TOKEN && process.env.FROM_EMAIL);
}

export const EMAIL_SEND_TIMEOUT_MS = 10_000;

/*
 * Postmark via its plain REST API rather than the official SDK: the SDK rides on
 * axios, which is not a safe bet inside the Cloudflare Worker this server deploys
 * to, and one POST does not need a client library.
 */
export async function sendEmail(
  { to, subject, html }: SendEmailOptions,
  options: { fetch?: typeof fetch } = {},
): Promise<void> {
  if (!emailConfigured()) throw new Error("Email delivery is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMAIL_SEND_TIMEOUT_MS);
  try {
    const response = await (options.fetch ?? fetch)("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-postmark-server-token": process.env.POSTMARK_SERVER_TOKEN!,
      },
      body: JSON.stringify({
        From: process.env.FROM_EMAIL,
        To: to,
        Subject: subject,
        HtmlBody: html,
        MessageStream: "outbound",
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as { ErrorCode?: number; Message?: string };
    if (!response.ok || body.ErrorCode !== 0) {
      throw new Error(`Postmark returned ${response.status} (${body.ErrorCode ?? "?"}: ${body.Message ?? "unknown"})`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
