import type {
  Approval as WorkspaceApproval,
  ApprovalRequest as WorkspaceApprovalRequest,
  ApprovalResolvedEvent as WorkspaceApprovalResolvedEvent,
  Artefact as WorkspaceArtefact,
  CreateApproval as WorkspaceCreateApproval,
  Decision as WorkspaceDecision,
  Input as WorkspaceInput,
  InputAnswer as WorkspaceInputAnswer,
  InputOption as WorkspaceInputOption,
  InputRequest as WorkspaceInputRequest,
  InputResolvedEvent as WorkspaceInputResolvedEvent,
  InputState as WorkspaceInputState,
  InputType as WorkspaceInputType,
  SealedCallbackStateEnvelope as WorkspaceSealedCallbackStateEnvelope,
  Session as WorkspaceSession,
  WebhookEvent as WorkspaceWebhookEvent,
} from "@mayi/contracts";
import type {
  Approval,
  ApprovalRequest,
  ApprovalResolvedEvent,
  Artefact,
  CreateApproval,
  Decision,
  Input,
  InputAnswer,
  InputOption,
  InputRequest,
  InputResolvedEvent,
  InputState,
  InputType,
  SealedCallbackStateEnvelope,
  Session,
  WebhookEvent,
} from "./public-contracts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<Value extends true> = Value;

export type PublicContractParityChecks = [
  Assert<Equal<Approval, WorkspaceApproval>>,
  Assert<Equal<ApprovalRequest, WorkspaceApprovalRequest>>,
  Assert<ApprovalResolvedEvent extends WorkspaceApprovalResolvedEvent ? true : false>,
  Assert<WorkspaceApprovalResolvedEvent extends ApprovalResolvedEvent ? true : false>,
  Assert<Equal<Artefact, WorkspaceArtefact>>,
  Assert<Equal<CreateApproval, WorkspaceCreateApproval>>,
  Assert<Equal<Decision, WorkspaceDecision>>,
  Assert<Equal<Input, WorkspaceInput>>,
  Assert<Equal<InputAnswer, WorkspaceInputAnswer>>,
  Assert<Equal<InputOption, WorkspaceInputOption>>,
  Assert<Equal<InputRequest, WorkspaceInputRequest>>,
  Assert<InputResolvedEvent extends WorkspaceInputResolvedEvent ? true : false>,
  Assert<WorkspaceInputResolvedEvent extends InputResolvedEvent ? true : false>,
  Assert<Equal<InputState, WorkspaceInputState>>,
  Assert<Equal<InputType, WorkspaceInputType>>,
  Assert<Equal<SealedCallbackStateEnvelope, WorkspaceSealedCallbackStateEnvelope>>,
  Assert<Equal<Session, WorkspaceSession>>,
  Assert<WebhookEvent extends WorkspaceWebhookEvent ? true : false>,
  Assert<WorkspaceWebhookEvent extends WebhookEvent ? true : false>,
];
