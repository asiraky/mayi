import type { Action } from "@mayi/contracts";
import { sql } from "drizzle-orm";
import {
  boolean, check, customType, index, integer, jsonb, pgEnum, pgTable, primaryKey, text,
  timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";

const identifier = customType<{ data: string }>({
  dataType: () => "mayi_id",
});

export const membershipRole = pgEnum("membership_role", ["OWNER", "APPROVER", "MEMBER"]);
export const approvalState = pgEnum("approval_state", ["DRAFT", "PENDING", "APPROVED", "DENIED", "EXPIRED", "CANCELLED"]);
export const enforcementMode = pgEnum("enforcement_mode", ["cooperative", "verified", "consumed"]);
export const destinationMode = pgEnum("destination_mode", ["notify_only", "may_decide"]);
export const destinationType = pgEnum("destination_type", ["WEBHOOK", "EMAIL"]);
export const callbackDeliveryStatus = pgEnum("callback_delivery_status", ["WAITING", "READY", "RUNNING", "FAILED", "DELIVERED", "DEAD_LETTER"]);
export const jobState = pgEnum("job_state", ["READY", "RUNNING", "SUCCEEDED", "FAILED", "DEAD_LETTER"]);

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const users = pgTable("users", {
  id: identifier("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [uniqueIndex("users_email_lower_uidx").on(sql`lower(${t.email})`)]);

export const workspaces = pgTable("workspaces", {
  id: identifier("id").primaryKey(),
  name: text("name").notNull(),
  policyVersion: integer("policy_version").default(1).notNull(),
  retentionDays: integer("retention_days").default(90).notNull(),
  createdAt,
});

export const memberships = pgTable("memberships", {
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  userId: identifier("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: membershipRole("role").notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt,
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index("memberships_user_idx").on(t.userId)]);

export const sessions = pgTable("sessions", {
  id: identifier("id").primaryKey(),
  userId: identifier("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  recentAuthAt: timestamp("recent_auth_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt,
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const oauthClients = pgTable("oauth_clients", {
  id: identifier("id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  approvalCallbackUris: text("approval_callback_uris").array().notNull(),
  registrationIpHash: text("registration_ip_hash").notNull(),
  createdAt,
}, (t) => [
  index("oauth_clients_registration_ip_created_idx").on(t.registrationIpHash, t.createdAt),
  check("oauth_clients_redirect_uri_count_check", sql`cardinality(${t.redirectUris}) BETWEEN 1 AND 5`),
  check("oauth_clients_approval_callback_uri_count_check", sql`cardinality(${t.approvalCallbackUris}) <= 10`),
]);

export const agents = pgTable("agents", {
  id: identifier("id").primaryKey(),
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  clientId: identifier("client_id").references(() => oauthClients.id),
  scopes: text("scopes").array().notNull(),
  credentialHash: text("credential_hash"),
  credentialExpiresAt: timestamp("credential_expires_at", { withTimezone: true }),
  createdBy: identifier("created_by").references(() => users.id).notNull(),
  createdAt,
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [index("agents_workspace_idx").on(t.workspaceId), index("agents_client_idx").on(t.clientId)]);

export const oauthCodes = pgTable("oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  userId: identifier("user_id").references(() => users.id).notNull(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  scopes: text("scopes").array().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt,
});

export const refreshTokens = pgTable("refresh_tokens", {
  id: identifier("id").primaryKey(),
  agentId: identifier("agent_id").references(() => agents.id, { onDelete: "cascade" }).notNull(),
  familyId: identifier("family_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt,
  usedAt: timestamp("used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const approvals = pgTable("approvals", {
  id: identifier("id").primaryKey(),
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  agentId: identifier("agent_id").references(() => agents.id).notNull(),
  state: approvalState("state").default("DRAFT").notNull(),
  action: jsonb("action").$type<Action>().notNull(),
  explanation: text("explanation").notNull(),
  enforcement: enforcementMode("enforcement").default("cooperative").notNull(),
  actionDigest: text("action_digest"),
  manifestDigest: text("manifest_digest"),
  policyVersion: integer("policy_version"),
  highRisk: boolean("high_risk").default(false).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt,
  sealedAt: timestamp("sealed_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  approverId: identifier("approver_id").references(() => users.id),
  decisionComment: text("decision_comment"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
}, (t) => [
  index("approvals_workspace_state_idx").on(t.workspaceId, t.state, t.createdAt),
  check("approval_digest_sealed_check", sql`${t.state} = 'DRAFT' OR (${t.actionDigest} IS NOT NULL AND ${t.manifestDigest} IS NOT NULL AND ${t.sealedAt} IS NOT NULL)`),
]);

export const approvalCallbacks = pgTable("approval_callbacks", {
  id: identifier("id").primaryKey(),
  approvalId: identifier("approval_id").references(() => approvals.id, { onDelete: "cascade" }).notNull(),
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  url: text("url").notNull(),
  state: text("state").notNull(),
  deliveryStatus: callbackDeliveryStatus("delivery_status").default("WAITING").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastError: text("last_error"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  createdAt,
  completedAt: timestamp("completed_at", { withTimezone: true }),
  deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("approval_callbacks_approval_uidx").on(t.approvalId),
  index("approval_callbacks_workspace_idx").on(t.workspaceId, t.createdAt),
  index("approval_callbacks_delivery_idx").on(t.deliveryStatus, t.nextAttemptAt),
  check("approval_callbacks_url_length_check", sql`char_length(${t.url}) BETWEEN 1 AND 2048`),
  check("approval_callbacks_state_length_check", sql`char_length(${t.state}) BETWEEN 1 AND 32768`),
  check("approval_callbacks_attempts_check", sql`${t.attempts} BETWEEN 0 AND 10`),
  check("approval_callbacks_last_error_length_check", sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 200`),
  check("approval_callbacks_occurred_check", sql`(${t.deliveryStatus} = 'WAITING') = (${t.occurredAt} IS NULL)`),
  check("approval_callbacks_running_lease_check", sql`${t.deliveryStatus} <> 'RUNNING' OR ${t.leaseExpiresAt} IS NOT NULL`),
  check("approval_callbacks_completed_check", sql`(${t.deliveryStatus} = 'DELIVERED') = (${t.completedAt} IS NOT NULL)`),
  check("approval_callbacks_dead_lettered_check", sql`(${t.deliveryStatus} = 'DEAD_LETTER') = (${t.deadLetteredAt} IS NOT NULL)`),
]);

export const artefacts = pgTable("artefacts", {
  id: identifier("id").primaryKey(),
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  approvalId: identifier("approval_id").references(() => approvals.id, { onDelete: "cascade" }).notNull(),
  objectKey: text("object_key").notNull().unique(),
  filename: text("filename").notNull(),
  mediaType: text("media_type").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  state: text("state").default("READY").notNull(),
  createdAt,
}, (t) => [index("artefacts_approval_idx").on(t.workspaceId, t.approvalId)]);

export const approvalArtefacts = pgTable("approval_artefacts", {
  approvalId: identifier("approval_id").references(() => approvals.id, { onDelete: "cascade" }).notNull(),
  artefactId: identifier("artefact_id").references(() => artefacts.id, { onDelete: "restrict" }).notNull(),
  ordinal: integer("ordinal").notNull(),
}, (t) => [primaryKey({ columns: [t.approvalId, t.artefactId] }), uniqueIndex("approval_artefact_ordinal_uidx").on(t.approvalId, t.ordinal)]);

export const eligibleApprovers = pgTable("eligible_approvers", {
  approvalId: identifier("approval_id").references(() => approvals.id, { onDelete: "cascade" }).notNull(),
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  userId: identifier("user_id").references(() => users.id).notNull(),
}, (t) => [primaryKey({ columns: [t.approvalId, t.userId] }), index("eligible_user_idx").on(t.workspaceId, t.userId)]);

export const idempotencyKeys = pgTable("idempotency_keys", {
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  credentialId: identifier("credential_id").notNull(),
  operation: text("operation").notNull(),
  key: text("key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  response: jsonb("response").notNull(),
  createdAt,
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.credentialId, t.operation, t.key] })]);

export const receipts = pgTable("receipts", {
  id: identifier("id").primaryKey(),
  approvalId: identifier("approval_id").references(() => approvals.id, { onDelete: "cascade" }).notNull().unique(),
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  audience: text("audience").notNull(),
  compactJws: text("compact_jws").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedBy: text("consumed_by"),
  createdAt,
});

export const auditEvents = pgTable("audit_events", {
  id: identifier("id").primaryKey(),
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  actorType: text("actor_type").notNull(),
  actorId: identifier("actor_id"),
  eventType: text("event_type").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: identifier("subject_id").notNull(),
  metadata: jsonb("metadata").default({}).notNull(),
  createdAt,
}, (t) => [index("audit_workspace_created_idx").on(t.workspaceId, t.createdAt)]);

export const devices = pgTable("devices", {
  id: identifier("id").primaryKey(),
  userId: identifier("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  expoPushToken: text("expo_push_token").notNull().unique(),
  platform: text("platform").notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt,
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
});

export const jobs = pgTable("jobs", {
  id: identifier("id").primaryKey(),
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  type: text("type").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  payload: jsonb("payload").notNull(),
  state: jobState("state").default("READY").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  leaseToken: identifier("lease_token"),
  lastError: text("last_error"),
  createdAt,
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("jobs_dedupe_uidx").on(t.type, t.dedupeKey),
  index("jobs_ready_idx").on(t.state, t.availableAt),
  check("jobs_attempts_check", sql`${t.attempts} >= 0`),
  check("jobs_last_error_length_check", sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 500`),
]);

export const forwardingDestinations = pgTable("forwarding_destinations", {
  id: identifier("id").primaryKey(),
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  type: destinationType("type").notNull(),
  name: text("name").notNull(),
  endpoint: text("endpoint").notNull(),
  mode: destinationMode("mode").default("notify_only").notNull(),
  publicJwk: jsonb("public_jwk"),
  mappedUserId: identifier("mapped_user_id").references(() => users.id),
  verificationHash: text("verification_hash"),
  verificationExpiresAt: timestamp("verification_expires_at", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  active: boolean("active").default(true).notNull(),
  createdAt,
}, (t) => [index("destinations_workspace_idx").on(t.workspaceId)]);

export const forwardingRules = pgTable("forwarding_rules", {
  id: identifier("id").primaryKey(),
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  destinationId: identifier("destination_id").references(() => forwardingDestinations.id, { onDelete: "cascade" }).notNull(),
  actionKind: text("action_kind").notNull(),
  includeAction: boolean("include_action").default(false).notNull(),
  includeArtefactMetadata: boolean("include_artefact_metadata").default(false).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt,
}, (t) => [index("forwarding_rules_match_idx").on(t.workspaceId, t.actionKind)]);

export const forwardingDeliveries = pgTable("forwarding_deliveries", {
  id: identifier("id").primaryKey(),
  workspaceId: identifier("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  approvalId: identifier("approval_id").references(() => approvals.id, { onDelete: "cascade" }).notNull(),
  destinationId: identifier("destination_id").references(() => forwardingDestinations.id, { onDelete: "cascade" }).notNull(),
  originId: identifier("origin_id").notNull(),
  hopCount: integer("hop_count").default(1).notNull(),
  state: text("state").default("PENDING").notNull(),
  responseCode: integer("response_code"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt,
}, (t) => [uniqueIndex("delivery_approval_destination_uidx").on(t.approvalId, t.destinationId), index("delivery_workspace_idx").on(t.workspaceId, t.createdAt)]);

export const externalNonces = pgTable("external_nonces", {
  destinationId: identifier("destination_id").references(() => forwardingDestinations.id, { onDelete: "cascade" }).notNull(),
  nonce: text("nonce").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.destinationId, t.nonce] })]);

export const bootstrap = pgTable("bootstrap", {
  singleton: boolean("singleton").primaryKey().default(true),
  secretHash: text("secret_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});
