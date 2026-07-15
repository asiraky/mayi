import { z } from "zod";
import { Action } from "./action";
import { Id } from "./id";

export const MAX_CALLBACK_STATE_LENGTH = 32 * 1024;
export const MAX_APPROVAL_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/**
 * Terminal callbacks keep their original event ID and occurrence time across
 * automatic attempts and operator replay. Consumers therefore accept that
 * stable event for seven days after resolution. Callback state is retained for
 * the same interval after the approval's latest possible expiry.
 */
export const CALLBACK_ACCEPTANCE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export const ApprovalCallback = z.object({
  url: z.url().max(2_048),
  state: z.string().min(1).max(MAX_CALLBACK_STATE_LENGTH),
}).strict();
export type ApprovalCallback = z.infer<typeof ApprovalCallback>;

export const ApprovalRequest = z.object({
  action: Action,
  explanation: z.string().min(1).max(10_000),
  suggestedApproverId: Id.optional(),
  expiresInSeconds: z.number().int().min(60).max(MAX_APPROVAL_LIFETIME_SECONDS),
  callback: ApprovalCallback,
  artefactIds: z.array(Id).max(20).optional(),
}).strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

const ApprovalResolvedEventBaseV1 = z.object({
  id: Id,
  type: z.literal("approval.resolved"),
  version: z.literal(1),
  approvalId: Id,
  state: z.string().min(1).max(MAX_CALLBACK_STATE_LENGTH),
  occurredAt: z.iso.datetime(),
});

const Approver = z.object({ id: Id }).strict();

export const ApprovalResolvedEventV1 = z.discriminatedUnion("status", [
  ApprovalResolvedEventBaseV1.extend({
    status: z.literal("approved"),
    approver: Approver,
    receipt: z.string().min(1).max(64 * 1024),
  }).strict(),
  ApprovalResolvedEventBaseV1.extend({
    status: z.literal("denied"),
    approver: Approver,
  }).strict(),
  ApprovalResolvedEventBaseV1.extend({ status: z.literal("expired") }).strict(),
  ApprovalResolvedEventBaseV1.extend({ status: z.literal("cancelled") }).strict(),
]);
export type ApprovalResolvedEventV1 = z.infer<typeof ApprovalResolvedEventV1>;

export const ApprovalResolvedEvent = ApprovalResolvedEventV1;
export type ApprovalResolvedEvent = ApprovalResolvedEventV1;

const Base64Url = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);

export const SealedCallbackStateEnvelopeV1 = z.object({
  version: z.literal(1),
  kid: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  nonce: Base64Url.max(128),
  ciphertext: Base64Url.max(MAX_CALLBACK_STATE_LENGTH),
}).strict();
export type SealedCallbackStateEnvelopeV1 = z.infer<typeof SealedCallbackStateEnvelopeV1>;

export const SealedCallbackStateEnvelope = SealedCallbackStateEnvelopeV1;
export type SealedCallbackStateEnvelope = SealedCallbackStateEnvelopeV1;
