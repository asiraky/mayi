import type {
  Approval as WorkspaceApproval,
  ApprovalRequest as WorkspaceApprovalRequest,
  ApprovalResolvedEvent as WorkspaceApprovalResolvedEvent,
  Artefact as WorkspaceArtefact,
  CreateApproval as WorkspaceCreateApproval,
  Decision as WorkspaceDecision,
  SealedCallbackStateEnvelope as WorkspaceSealedCallbackStateEnvelope,
  Session as WorkspaceSession,
} from "@mayi/contracts";
import type {
  Approval,
  ApprovalRequest,
  ApprovalResolvedEvent,
  Artefact,
  CreateApproval,
  Decision,
  SealedCallbackStateEnvelope,
  Session,
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
  Assert<Equal<SealedCallbackStateEnvelope, WorkspaceSealedCallbackStateEnvelope>>,
  Assert<Equal<Session, WorkspaceSession>>,
];
