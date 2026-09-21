import { reviewDigest } from "@mayi/contracts";
import type { DatabaseSql } from "@mayi/db";
import { createError } from "h3";

export type ReviewContentInput = {
  title?: string | undefined;
  explanation: string;
  reviewMarkdown?: string | undefined;
  supersedesApprovalId?: string | undefined;
};

export type ReviewContentColumns = {
  title: string | null;
  reviewMarkdown: string | null;
  reviewDigest: string;
  supersedesApprovalId: string | null;
};

const TERMINAL_STATES = new Set(["APPROVED", "DENIED", "EXPIRED", "CANCELLED"]);
const SUPERSEDES_UNIQUE_INDEX = "approvals_supersedes_uidx";

/**
 * Freezes what the reviewer will read and validates the revision link for a new approval.
 * Call inside the creating transaction: the predecessor row is locked so two requests
 * revising the same approval serialize, and the partial unique index backs that up.
 */
export async function prepareReviewContent(
  sql: DatabaseSql,
  owner: { workspaceId: string; agentId: string },
  input: ReviewContentInput,
): Promise<ReviewContentColumns> {
  const supersedesApprovalId = input.supersedesApprovalId ?? null;
  if (supersedesApprovalId) {
    const [previous] = await sql`
      select agent_id, state,
        exists (select 1 from approvals s where s.supersedes_approval_id = a.id) as superseded
      from approvals a
      where a.id = ${supersedesApprovalId} and a.workspace_id = ${owner.workspaceId}
      for update of a
    `;
    // Another agent's approval is reported exactly like a missing one so an agent cannot
    // probe for approvals it does not own.
    if (!previous || String(previous.agent_id) !== owner.agentId) {
      throw createError({ statusCode: 422, statusMessage: "supersedesApprovalId must name an approval this agent created" });
    }
    if (!TERMINAL_STATES.has(String(previous.state))) {
      throw createError({ statusCode: 409, statusMessage: "The approval being revised is still open; it must be resolved or cancelled first" });
    }
    if (previous.superseded) {
      throw createError({ statusCode: 409, statusMessage: "The approval being revised already has a revision" });
    }
  }
  return {
    title: input.title ?? null,
    reviewMarkdown: input.reviewMarkdown ?? null,
    reviewDigest: await reviewDigest(input),
    supersedesApprovalId,
  };
}

/** Maps a lost race on the one-successor index to the same 409 the pre-check returns. */
export function rethrowSupersedesConflict(error: unknown): never {
  if (
    error && typeof error === "object"
    && (error as { code?: unknown }).code === "23505"
    && (error as { constraint_name?: unknown }).constraint_name === SUPERSEDES_UNIQUE_INDEX
  ) {
    throw createError({ statusCode: 409, statusMessage: "The approval being revised already has a revision" });
  }
  throw error;
}
