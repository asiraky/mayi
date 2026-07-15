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
