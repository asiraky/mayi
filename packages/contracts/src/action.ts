import { z } from "zod";

export const JsonValue: z.ZodType<unknown> = z.json();

const ActionInput = z.record(z.string(), JsonValue);

export const ToolCallAction = z.object({
  kind: z.literal("tool-call"),
  toolName: z.string().min(1).max(255),
  callId: z.string().min(1).max(255),
  input: ActionInput,
}).strict();
export type ToolCallAction = z.infer<typeof ToolCallAction>;

export const VersionedAction = z.object({
  kind: z.string().min(1).max(100).refine((kind) => kind !== "tool-call", {
    message: 'The "tool-call" kind must use the tool-call action shape',
  }),
  version: z.string().min(1).max(32),
  audience: z.string().min(1).max(255),
  input: ActionInput,
  resourceVersion: z.string().max(255).optional(),
}).strict();
export type VersionedAction = z.infer<typeof VersionedAction>;

export const Action = z.union([ToolCallAction, VersionedAction]);
export type Action = z.infer<typeof Action>;

export function isToolCallAction(action: Action): action is ToolCallAction {
  return action.kind === "tool-call";
}

export function actionName(action: Action): string {
  return isToolCallAction(action) ? action.toolName : action.kind;
}

export function actionAudience(action: Action): string | undefined {
  return isToolCallAction(action) ? undefined : action.audience;
}
