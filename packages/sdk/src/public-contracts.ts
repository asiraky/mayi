export type ToolCallAction = {
  kind: "tool-call";
  toolName: string;
  callId: string;
  input: Record<string, unknown>;
};

export type VersionedAction = {
  kind: string;
  version: string;
  audience: string;
  input: Record<string, unknown>;
  resourceVersion?: string | undefined;
};

export type Action = ToolCallAction | VersionedAction;
export type ApprovalState = "DRAFT" | "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" | "CANCELLED";
export type EnforcementMode = "cooperative" | "verified" | "consumed";

export interface Artefact {
  id: string;
  ordinal: number;
  filename: string;
  mediaType: "application/pdf" | "image/png" | "image/jpeg" | "image/webp";
  size: number;
  sha256: string;
}

export interface CreateApproval {
  action: Action;
  explanation: string;
  expiresInSeconds: number;
  enforcement: EnforcementMode;
  suggestedApproverId?: string | undefined;
}

export interface Decision {
  decision: "APPROVED" | "DENIED";
  comment?: string | undefined;
}

export interface Approval {
  id: string;
  workspaceId: string;
  agentId: string;
  state: ApprovalState;
  action: Action;
  explanation: string;
  enforcement: EnforcementMode;
  actionDigest: string | null;
  manifestDigest: string | null;
  artefacts: Artefact[];
  createdAt: string;
  sealedAt: string | null;
  expiresAt: string;
  decidedAt: string | null;
  decisionComment: string | null;
  approverId: string | null;
  receipt?: string | undefined;
}

export interface Session {
  user: { id: string; email: string; displayName: string };
  workspace: { id: string; name: string };
  recentAuthAt: string;
}

export interface ApprovalCallback {
  url: string;
  state: string;
}

export interface ApprovalRequest {
  action: Action;
  explanation: string;
  suggestedApproverId?: string | undefined;
  expiresInSeconds: number;
  callback: ApprovalCallback;
  artefactIds?: string[] | undefined;
}

export type StagedArtefact = Omit<Artefact, "ordinal">;

interface ApprovalResolvedEventBase {
  id: string;
  type: "approval.resolved";
  version: 1;
  approvalId: string;
  state: string;
  occurredAt: string;
}

export type ApprovalResolvedEvent =
  | (ApprovalResolvedEventBase & { status: "approved"; approver: { id: string }; receipt: string })
  | (ApprovalResolvedEventBase & { status: "denied"; approver: { id: string } })
  | (ApprovalResolvedEventBase & { status: "expired" })
  | (ApprovalResolvedEventBase & { status: "cancelled" });

export interface SealedCallbackStateEnvelope {
  version: 1;
  kid: string;
  nonce: string;
  ciphertext: string;
}

export type InputType = "text" | "select" | "confirmation";
export type InputState = "PENDING" | "ANSWERED" | "EXPIRED" | "CANCELLED";

export interface InputOption {
  id: string;
  label: string;
  description?: string | undefined;
  style?: "danger" | "default" | "primary" | undefined;
}

export interface InputRequest {
  type: InputType;
  prompt: string;
  options?: InputOption[] | undefined;
  allowFreeform?: boolean | undefined;
  expiresInSeconds: number;
  suggestedApproverId?: string | undefined;
  callback?: ApprovalCallback | undefined;
}

export interface InputAnswer {
  optionId?: string | undefined;
  text?: string | undefined;
}

export interface Input {
  id: string;
  type: InputType;
  prompt: string;
  options: InputOption[] | null;
  allowFreeform: boolean;
  state: InputState;
  answer: InputAnswer | null;
  attestation: string | null;
  respondentId: string | null;
  agentId: string;
  createdAt: string;
  expiresAt: string;
  answeredAt: string | null;
  cancelledAt: string | null;
}

interface InputResolvedEventBase {
  id: string;
  type: "input.resolved";
  version: 1;
  inputId: string;
  state: string;
  occurredAt: string;
}

export type InputResolvedEvent =
  | (InputResolvedEventBase & {
    status: "answered";
    respondent: { id: string; email: string | null };
    answer: InputAnswer;
    attestation: string;
  })
  | (InputResolvedEventBase & { status: "expired" })
  | (InputResolvedEventBase & { status: "cancelled" });

export type WebhookEvent = ApprovalResolvedEvent | InputResolvedEvent;
