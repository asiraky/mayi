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

/** Optional human review content any approval request may carry. */
export interface ReviewContent {
  /** One line, 1–200 characters, not blank. The reviewer sees it first. */
  title?: string | undefined;
  /** Markdown (CommonMark + GFM tables), 1–100000 characters. Rendered without raw HTML or images. */
  reviewMarkdown?: string | undefined;
  /** A resolved approval created by the same agent that this request revises. */
  supersedesApprovalId?: string | undefined;
}

export interface CreateApproval extends ReviewContent {
  action: Action;
  explanation: string;
  expiresInSeconds: number;
  enforcement: EnforcementMode;
  suggestedApproverId?: string | undefined;
}

/** CHANGES_REQUESTED is a denial that carries required reviewer feedback. */
export type DecisionOutcome = "APPROVED" | "DENIED" | "CHANGES_REQUESTED";

export interface Decision {
  decision: DecisionOutcome;
  /** Required (non-blank) for CHANGES_REQUESTED; at most 4000 characters. */
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
  decisionOutcome: DecisionOutcome | null;
  approverId: string | null;
  title: string | null;
  reviewMarkdown: string | null;
  /** reviewDigest() of the title, explanation and review document; bound into receipts. */
  reviewDigest: string | null;
  supersedesApprovalId: string | null;
  supersededByApprovalId: string | null;
  /** Absolute web URL where a human reviews this approval. */
  reviewUrl: string | null;
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

export interface ApprovalRequest extends ReviewContent {
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
