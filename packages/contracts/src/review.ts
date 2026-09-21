import { z } from "zod";
import { canonicalDigest } from "./canonical";
import { Id } from "./id";

export const MAX_REVIEW_TITLE_LENGTH = 200;
export const MAX_REVIEW_MARKDOWN_LENGTH = 100_000;
export const MAX_DECISION_COMMENT_LENGTH = 4_000;

const notBlank = (value: string) => value.trim().length > 0;

/** A one-line, human-readable name for what the reviewer is being asked to authorize. */
export const ReviewTitle = z.string().min(1).max(MAX_REVIEW_TITLE_LENGTH)
  .refine(notBlank, { message: "Title must not be blank" })
  .refine((value) => !/[\r\n]/.test(value), { message: "Title must be a single line" });

/**
 * A Markdown review document (CommonMark + GFM tables). It is explanatory content for
 * the human reviewer only: May I? never interprets it for authorization, and the web
 * app renders it without raw HTML or images.
 */
export const ReviewMarkdown = z.string().min(1).max(MAX_REVIEW_MARKDOWN_LENGTH)
  .refine(notBlank, { message: "Review document must not be blank" });

/** Fields an integration may add to any approval request to give the reviewer context. */
export const ReviewContent = {
  title: ReviewTitle.optional(),
  reviewMarkdown: ReviewMarkdown.optional(),
  /** A prior, resolved approval this request revises. It must belong to the same agent. */
  supersedesApprovalId: Id.optional(),
};

/**
 * The outcome a reviewer chose. CHANGES_REQUESTED is a denial: the approval's state
 * becomes DENIED, no receipt is issued, and the resolved callback reports "denied".
 */
export const DecisionOutcome = z.enum(["APPROVED", "DENIED", "CHANGES_REQUESTED"]);
export type DecisionOutcome = z.infer<typeof DecisionOutcome>;

export const REVIEW_DIGEST_VERSION = 1;

/**
 * SHA-256 (hex) over the canonical JSON of exactly what the reviewer read:
 * `{ explanation, reviewMarkdown, title, v: 1 }`, absent fields as null. It is frozen on
 * the approval at creation and carried as the `review_digest` claim of an approved
 * receipt, so an integration can prove which proposal a receipt authorizes.
 */
export async function reviewDigest(content: {
  title?: string | null | undefined;
  explanation: string;
  reviewMarkdown?: string | null | undefined;
}): Promise<string> {
  return canonicalDigest({
    v: REVIEW_DIGEST_VERSION,
    title: content.title ?? null,
    explanation: content.explanation,
    reviewMarkdown: content.reviewMarkdown ?? null,
  });
}
