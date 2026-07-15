import { z } from "zod";
import { Id } from "./id";

export * from "./canonical";
export * from "./id";

export const ApprovalState = z.enum(["DRAFT", "PENDING", "APPROVED", "DENIED", "EXPIRED", "CANCELLED"]);
export type ApprovalState = z.infer<typeof ApprovalState>;

export const EnforcementMode = z.enum(["cooperative", "verified", "consumed"]);
export type EnforcementMode = z.infer<typeof EnforcementMode>;

export const JsonValue: z.ZodType<unknown> = z.json();

export const Action = z.object({
  kind: z.string().min(1).max(100),
  version: z.string().min(1).max(32),
  audience: z.string().min(1).max(255),
  parameters: z.record(z.string(), JsonValue),
  resourceVersion: z.string().max(255).optional(),
});
export type Action = z.infer<typeof Action>;

export const Artefact = z.object({
  id: Id,
  ordinal: z.number().int().nonnegative(),
  filename: z.string().min(1).max(255),
  mediaType: z.enum(["application/pdf", "image/png", "image/jpeg", "image/webp"]),
  size: z.number().int().positive().max(25 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Artefact = z.infer<typeof Artefact>;

export const CreateApproval = z.object({
  action: Action,
  explanation: z.string().min(1).max(10_000),
  expiresInSeconds: z.number().int().min(60).max(7 * 24 * 60 * 60).default(3600),
  enforcement: EnforcementMode.default("cooperative"),
  suggestedApproverId: Id.optional(),
});
export type CreateApproval = z.infer<typeof CreateApproval>;

export const SealApproval = z.object({ artefactIds: z.array(Id).max(20).default([]) });
export const Decision = z.object({
  decision: z.enum(["APPROVED", "DENIED"]),
  comment: z.string().max(4_000).optional(),
});
export type Decision = z.infer<typeof Decision>;

export const Approval = z.object({
  id: Id,
  workspaceId: Id,
  agentId: Id,
  state: ApprovalState,
  action: Action,
  explanation: z.string(),
  enforcement: EnforcementMode,
  actionDigest: z.string().nullable(),
  manifestDigest: z.string().nullable(),
  artefacts: z.array(Artefact),
  createdAt: z.iso.datetime(),
  sealedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  decisionComment: z.string().nullable(),
  approverId: Id.nullable(),
  receipt: z.string().optional(),
});
export type Approval = z.infer<typeof Approval>;

export const Session = z.object({
  user: z.object({ id: Id, email: z.email(), displayName: z.string() }),
  workspace: z.object({ id: Id, name: z.string() }),
  recentAuthAt: z.iso.datetime(),
});
export type Session = z.infer<typeof Session>;

/*
 * Signup only. Signin deliberately stays min(1): it verifies a password that already
 * exists rather than enforcing policy on it, so tightening the rules here never locks
 * anyone out of an account they already have, and a rejection at signin cannot be used
 * to infer the policy.
 *
 * The messages are per-rule so the form can say which rule failed rather than restating
 * all of them on every keystroke.
 */
export const Password = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(256)
  .regex(/[A-Za-z]/, "Include a letter.")
  .regex(/[0-9]/, "Include a number.")
  .regex(/[^A-Za-z0-9]/, "Include a special character.");

export const Signup = z.object({
  email: z.email(),
  password: Password,
  displayName: z.string().min(1).max(100),
  bootstrapSecret: z.string().min(20).optional(),
});
export const Signin = z.object({ email: z.email(), password: z.string().min(1).max(256) });

export const AgentGrant = z.object({
  id: Id,
  name: z.string(),
  scopes: z.array(z.enum(["approval:create", "approval:read", "approval:cancel"])),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});

export type ApiError = { error: { code: string; message: string; details?: unknown } };
