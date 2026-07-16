import { z } from "zod";
import { ApprovalCallback, ApprovalResolvedEvent, MAX_APPROVAL_LIFETIME_SECONDS, MAX_CALLBACK_STATE_LENGTH } from "./approval-callback";
import { Id } from "./id";

export const MAX_INPUT_OPTIONS = 20;
export const MAX_INPUT_TEXT_LENGTH = 10_000;

export const InputType = z.enum(["text", "select", "confirmation"]);
export type InputType = z.infer<typeof InputType>;

export const InputOption = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  style: z.enum(["danger", "default", "primary"]).optional(),
}).strict();
export type InputOption = z.infer<typeof InputOption>;

export const InputRequest = z.object({
  type: InputType,
  prompt: z.string().min(1).max(4_000),
  options: z.array(InputOption).min(1).max(MAX_INPUT_OPTIONS).optional(),
  allowFreeform: z.boolean().optional(),
  expiresInSeconds: z.number().int().min(60).max(MAX_APPROVAL_LIFETIME_SECONDS),
  suggestedApproverId: Id.optional(),
  callback: ApprovalCallback.optional(),
}).strict().superRefine((request, ctx) => {
  if (request.type === "text") {
    if (request.options !== undefined) ctx.addIssue({ code: "custom", path: ["options"], message: "Text inputs take no options" });
    if (request.allowFreeform !== undefined) ctx.addIssue({ code: "custom", path: ["allowFreeform"], message: "Text inputs are inherently freeform; omit allowFreeform" });
    return;
  }
  if (request.options === undefined) {
    ctx.addIssue({ code: "custom", path: ["options"], message: `Options are required for ${request.type} inputs` });
    return;
  }
  if (new Set(request.options.map((option) => option.id)).size !== request.options.length) {
    ctx.addIssue({ code: "custom", path: ["options"], message: "Option ids must be unique" });
  }
  if (request.type === "confirmation") {
    if (request.options.length !== 2) ctx.addIssue({ code: "custom", path: ["options"], message: "Confirmation inputs require exactly two options" });
    if (request.allowFreeform === true) ctx.addIssue({ code: "custom", path: ["allowFreeform"], message: "Confirmation inputs do not allow freeform answers" });
  }
});
export type InputRequest = z.infer<typeof InputRequest>;

export const InputAnswer = z.object({
  optionId: z.string().min(1).max(64).optional(),
  text: z.string().min(1).max(MAX_INPUT_TEXT_LENGTH).optional(),
}).strict().refine((answer) => answer.optionId !== undefined || answer.text !== undefined, {
  message: "An answer requires an optionId or text",
});
export type InputAnswer = z.infer<typeof InputAnswer>;

export const InputState = z.enum(["PENDING", "ANSWERED", "EXPIRED", "CANCELLED"]);
export type InputState = z.infer<typeof InputState>;

export const Input = z.object({
  id: Id,
  type: InputType,
  prompt: z.string(),
  options: z.array(InputOption).nullable(),
  allowFreeform: z.boolean(),
  state: InputState,
  answer: InputAnswer.nullable(),
  attestation: z.string().nullable(),
  respondentId: Id.nullable(),
  agentId: Id,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  answeredAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
});
export type Input = z.infer<typeof Input>;

const InputResolvedEventBaseV1 = z.object({
  id: Id,
  type: z.literal("input.resolved"),
  version: z.literal(1),
  inputId: Id,
  state: z.string().min(1).max(MAX_CALLBACK_STATE_LENGTH),
  occurredAt: z.iso.datetime(),
});

const Respondent = z.object({ id: Id, email: z.string().nullable() }).strict();

export const InputResolvedEventV1 = z.discriminatedUnion("status", [
  InputResolvedEventBaseV1.extend({
    status: z.literal("answered"),
    respondent: Respondent,
    answer: InputAnswer,
    attestation: z.string().min(1).max(64 * 1024),
  }).strict(),
  InputResolvedEventBaseV1.extend({ status: z.literal("expired") }).strict(),
  InputResolvedEventBaseV1.extend({ status: z.literal("cancelled") }).strict(),
]);
export type InputResolvedEventV1 = z.infer<typeof InputResolvedEventV1>;

export const InputResolvedEvent = InputResolvedEventV1;
export type InputResolvedEvent = InputResolvedEventV1;

export const WebhookEvent = z.union([ApprovalResolvedEvent, InputResolvedEvent]);
export type WebhookEvent = z.infer<typeof WebhookEvent>;
