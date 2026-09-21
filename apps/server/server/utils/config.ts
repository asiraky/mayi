export type AppConfig = ReturnType<typeof getConfig>;

export function getConfig() {
  return {
    publicOrigin: process.env.PUBLIC_ORIGIN ?? "http://localhost:3000",
    secureCookies: process.env.SESSION_COOKIE_SECURE !== "false",
    receiptIssuer: process.env.RECEIPT_ISSUER ?? process.env.PUBLIC_ORIGIN ?? "http://localhost:3000",
    receiptAudience: process.env.RECEIPT_AUDIENCE ?? "local-executor",
    receiptPrivateJwk: process.env.RECEIPT_PRIVATE_JWK,
    receiptPublicJwk: process.env.RECEIPT_PUBLIC_JWK,
    receiptPreviousPublicJwks: process.env.RECEIPT_PREVIOUS_PUBLIC_JWKS,
    bootstrapSecret: process.env.BOOTSTRAP_SECRET,
    retentionDays: Number(process.env.RETENTION_DAYS ?? 90),
  };
}

/**
 * Where humans open the web app. It is co-served by this server in production;
 * WEB_ORIGIN overrides for dev, where Vite hosts it on its own port.
 */
export function webOrigin(): string {
  return (process.env.WEB_ORIGIN ?? process.env.PUBLIC_ORIGIN ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** The one link to an approval's review page, shared by API responses and email. */
export function approvalReviewUrl(approvalId: string): string {
  return `${webOrigin()}/?approval=${encodeURIComponent(approvalId)}`;
}

export function inputReviewUrl(inputId: string): string {
  return `${webOrigin()}/?input=${encodeURIComponent(inputId)}`;
}
