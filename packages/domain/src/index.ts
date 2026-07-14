import type { Action, ApprovalState, Artefact } from "@mayi/contracts";
import { canonicalDigest } from "@mayi/contracts";
import { z } from "zod";

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

export const terminalStates = new Set<ApprovalState>(["APPROVED", "DENIED", "EXPIRED", "CANCELLED"]);

export function decisionTransition(state: ApprovalState, expiresAt: Date, now: Date, decision: "APPROVED" | "DENIED"): ApprovalState {
  if (state !== "PENDING") throw new DomainError("not_pending", `Approval is ${state.toLowerCase()}`, 409);
  if (expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return decision;
}

export function isHighRisk(action: Action): boolean {
  return action.kind.startsWith("admin.") || action.kind.endsWith(".delete") || action.kind.endsWith(".transfer");
}

const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
export const actionSchemas: Record<string, z.ZodType> = {
  "git.merge@1": z.object({ repository: z.string().min(1), sha, expectedHead: sha }).strict(),
  "deploy.release@1": z.object({ environment: z.string().min(1), releaseDigest: z.string().min(16), expectedCurrentRelease: z.string().min(1) }).strict(),
  "http.request@1": z.object({ method: z.enum(["POST", "PUT", "PATCH", "DELETE"]), url: z.url(), bodySha256: z.string().length(64).optional(), ifMatch: z.string().optional() }).strict(),
  "admin.user.delete@1": z.object({ userId: z.uuid(), expectedAccountVersion: z.string().min(1) }).strict(),
};

export function validateActionForEnforcement(action: Action, enforcement: "cooperative" | "verified" | "consumed"): void {
  const schema = actionSchemas[`${action.kind}@${action.version}`];
  if (!schema) {
    if (enforcement !== "cooperative") throw new DomainError("unverified_action_kind", "Verified or consumed enforcement requires a registered exact-action schema", 422);
    return;
  }
  const result = schema.safeParse(action.parameters);
  if (!result.success) throw new DomainError("invalid_exact_action", "Action parameters do not match the registered exact-action schema", 422);
}

export function requireRecentAuthentication(recentAuthAt: Date, now: Date, maxAgeSeconds = 300): void {
  if (now.getTime() - recentAuthAt.getTime() > maxAgeSeconds * 1000) {
    throw new DomainError("step_up_required", "Recent authentication is required", 403);
  }
}

export async function freezeDigests(action: Action, artefacts: Artefact[]): Promise<{ actionDigest: string; manifestDigest: string }> {
  const manifest = [...artefacts]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(({ ordinal, filename, mediaType, size, sha256 }) => ({ ordinal, filename, mediaType, size, sha256 }));
  return { actionDigest: await canonicalDigest(action), manifestDigest: await canonicalDigest(manifest) };
}

export function validateSuggestedApprover(suggestedId: string | undefined, eligibleIds: string[]): void {
  if (suggestedId && !eligibleIds.includes(suggestedId)) {
    throw new DomainError("ineligible_approver", "Suggested approver is outside server policy", 403);
  }
}
