import { actionName, isToolCallAction, type Approval, type DecisionOutcome } from "@mayi/contracts";
import { MayiHttpError, type MayiClient } from "@mayiapp/sdk";
import { ArrowLeft, ArrowRight, Check, ChevronRight, FileText, PencilLine, X } from "lucide-react";
import { lazy, Suspense, useEffect, useReducer, useRef, useState } from "react";
import { StateBadge } from "~/components/state-badge";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { fileSize, relativeTime } from "~/lib/format";

// The Markdown pipeline is most of the app's weight, and only this screen needs it,
// so the inbox does not pay for it on load.
const Markdown = lazy(() => import("~/components/markdown").then((module) => ({ default: module.Markdown })));

/*
 * What the agent writes for a person is the hero: its title (or, without one, its
 * explanation) is the heading, and the review document beneath it reads as prose —
 * the screen reads as someone asking for permission, not as a request being filed.
 * Everything the machine filed — the call, its arguments, the digests, the receipt —
 * still exists, but folded into the "Technical details" disclosure at the bottom.
 * That disclosure (and the Activity tab's expanders) is now the only place mono is
 * allowed; the primary surface is a person talking.
 *
 * The screen is laid out for the phone that opened it from a notification: the
 * decision bar stays pinned to the bottom of the viewport, so "read, scroll, approve"
 * never requires hunting for the buttons.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="py-1.5 text-[12px] text-muted-foreground">{label}</dt>
      <dd className="py-1.5 font-mono text-[12px] break-all text-foreground">{children}</dd>
    </>
  );
}

const OUTCOME_VERB: Record<DecisionOutcome, string> = {
  APPROVED: "Approved",
  DENIED: "Denied",
  CHANGES_REQUESTED: "Changes requested",
};

/** A real link (so it can open in a new tab) that navigates in place on a plain click. */
function ApprovalLink({
  id,
  onOpen,
  className,
  children,
}: {
  id: string;
  onOpen: (id: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={`?approval=${encodeURIComponent(id)}`}
      className={className}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpen(id);
      }}
    >
      {children}
    </a>
  );
}

/** The request this one revises: what was asked, how it was answered, and the feedback
 *  that prompted the revision — so the reviewer can check it was addressed. */
function RevisedRequest({ id, api, onOpen }: { id: string; api: MayiClient; onOpen: (id: string) => void }) {
  // undefined while loading, null if it could not be fetched.
  const [prior, setPrior] = useState<Approval | null>();

  useEffect(() => {
    let stale = false;
    api
      .approval(id)
      .then((value) => !stale && setPrior(value))
      .catch(() => !stale && setPrior(null));
    return () => {
      stale = true;
    };
  }, [api, id]);

  return (
    <ApprovalLink
      id={id}
      onOpen={onOpen}
      className="mt-4 grid gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/25"
    >
      <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="text-[13px] font-medium text-foreground">Revises an earlier request</span>
        {prior && <StateBadge state={prior.state} outcome={prior.decisionOutcome} />}
      </span>
      {prior === undefined && <span className="text-[13px] text-muted-foreground">Loading…</span>}
      {prior && (
        <>
          <span className="line-clamp-2 text-[14px] leading-[1.5] text-body">{prior.title ?? prior.explanation}</span>
          {prior.decisionComment && (
            <span className="grid gap-1 border-l-2 border-primary/40 pl-3">
              <span className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">Feedback</span>
              <span className="text-[14px] leading-[1.6] whitespace-pre-wrap text-body">{prior.decisionComment}</span>
            </span>
          )}
        </>
      )}
      <span className="inline-flex items-center gap-1 text-[13px] text-primary-ink">
        View earlier request
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </span>
    </ApprovalLink>
  );
}

function DecisionButtons({
  busy,
  onDecide,
}: {
  busy: DecisionOutcome | null;
  onDecide: (decision: DecisionOutcome) => void;
}) {
  // DOM order is primary first. On a phone Approve takes the whole top row with the
  // other two beneath it; from sm up the row reverses so Approve sits at the right
  // edge and Deny is pushed away to the left.
  return (
    <div className="flex flex-wrap gap-2 sm:flex-row-reverse sm:flex-nowrap sm:gap-3">
      <Button
        size="lg"
        disabled={busy !== null}
        onClick={() => onDecide("APPROVED")}
        className="h-11 basis-full text-[15px] sm:basis-auto sm:px-10"
      >
        <Check className="size-4" />
        {busy === "APPROVED" ? "Approving…" : "Approve"}
      </Button>
      <Button
        variant="outline"
        size="lg"
        disabled={busy !== null}
        onClick={() => onDecide("CHANGES_REQUESTED")}
        className="h-11 flex-1 text-[15px] sm:flex-none sm:px-6"
      >
        <PencilLine className="size-4" />
        {busy === "CHANGES_REQUESTED" ? "Sending…" : "Request changes"}
      </Button>
      <Button
        variant="ghost"
        size="lg"
        disabled={busy !== null}
        onClick={() => onDecide("DENIED")}
        className="h-11 px-5 text-[15px] text-destructive hover:bg-destructive/8 hover:text-destructive sm:mr-auto sm:px-6"
      >
        <X className="size-4" />
        {busy === "DENIED" ? "Denying…" : "Deny"}
      </Button>
    </div>
  );
}

export function ApprovalDetail({
  item,
  email,
  api,
  onBack,
  onOpenApproval,
  onRefresh,
}: {
  item: Approval;
  email: string;
  api: MayiClient;
  onBack: () => void;
  /** Opens another approval in place — used to walk the revision history. */
  onOpenApproval: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<DecisionOutcome | null>(null);
  const [error, setError] = useState("");
  const [feedbackError, setFeedbackError] = useState("");
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const pending = item.state === "PENDING";
  const outcome = item.decisionOutcome ?? (item.state === "APPROVED" || item.state === "DENIED" ? item.state : null);

  // The expiry line is a countdown; let it count. A 30s pulse is enough for the
  // minute-level phrasing relativeTime produces.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [pending]);

  async function decide(decision: DecisionOutcome) {
    const feedback = comment.trim();
    // Asking for changes without saying which is not an answer the agent can act on,
    // so it is caught here rather than bounced by the server.
    if (decision === "CHANGES_REQUESTED" && !feedback) {
      setFeedbackError("Say what should change. The agent uses your feedback to revise its request.");
      feedbackRef.current?.focus({ preventScroll: true });
      feedbackRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }

    setBusy(decision);
    setError("");
    setFeedbackError("");
    const body = { decision, ...(feedback ? { comment: feedback } : {}) };

    try {
      await api.decide(item.id, body);
      await onRefresh();
    } catch (cause) {
      // A high-risk action can demand a fresh authentication. Re-prompting inline and
      // retrying keeps the decision the user already made, rather than dropping it.
      if (cause instanceof MayiHttpError && cause.code === "step_up_required") {
        const password = window.prompt(
          "This action is marked high risk. Re-enter your password to continue.",
        );
        if (!password) return setBusy(null);
        try {
          await api.stepUp({ email, password });
          await api.decide(item.id, body);
          await onRefresh();
        } catch (retry) {
          setError(retry instanceof Error ? retry.message : "Decision failed");
        }
      } else {
        setError(cause instanceof Error ? cause.message : "Decision failed");
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto w-[min(760px,100%-2.5rem)] flex-1 pt-6 pb-10 sm:pt-10">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Inbox
        </button>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <p className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">
            Approval requested
          </p>
          {!pending && <StateBadge state={item.state} outcome={item.decisionOutcome} />}
        </div>

        {/* A replaced request is history; say so before anyone reads it as current. */}
        {item.supersededByApprovalId && (
          <ApprovalLink
            id={item.supersededByApprovalId}
            onOpen={onOpenApproval}
            className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-primary/25 bg-primary/8 px-4 py-3 text-[14px] text-primary-ink transition-colors hover:border-primary/45"
          >
            <span className="font-medium">A revised request replaced this one</span>
            <span className="inline-flex items-center gap-1 text-[13px]">
              View revision
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </span>
          </ApprovalLink>
        )}

        <h1 className="mt-3 max-w-[52ch] text-[clamp(1.3rem,4.5vw,1.7rem)] leading-[1.45] font-medium tracking-[-0.01em] text-body">
          {item.title ?? item.explanation}
        </h1>

        {item.title && (
          <p className="mt-4 max-w-[62ch] text-[16px] leading-[1.65] whitespace-pre-line text-body">{item.explanation}</p>
        )}

        <p className="mt-4 text-[13px] text-muted-foreground">
          {pending
            ? `Expires ${relativeTime(item.expiresAt)}`
            : item.decidedAt
              ? `${outcome ? OUTCOME_VERB[outcome] : "Decided"} ${relativeTime(item.decidedAt)}`
              : item.state === "EXPIRED"
                ? `Expired ${relativeTime(item.expiresAt)}`
                : null}
        </p>

        {item.reviewMarkdown && (
          <Suspense fallback={<p className="mt-8 border-t border-border pt-8 text-[14px] text-muted-foreground">Loading…</p>}>
            <Markdown className="mt-8 border-t border-border pt-8">{item.reviewMarkdown}</Markdown>
          </Suspense>
        )}

        {item.artefacts.length > 0 && (
          <section className="mt-10">
            <h2 className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">
              Attachments ({item.artefacts.length})
            </h2>
            <ul className="mt-4 grid gap-2">
              {item.artefacts.map((file) => (
                <li key={file.id}>
                  <a
                    href={`/api/approvals/${item.id}/artefacts/${file.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-foreground/25"
                  >
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-[14px]">{file.filename}</span>
                    <span className="shrink-0 text-[12px] text-muted-foreground">{fileSize(file.size)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {item.supersedesApprovalId && (
          <section className="mt-10">
            <h2 className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">History</h2>
            <RevisedRequest id={item.supersedesApprovalId} api={api} onOpen={onOpenApproval} />
          </section>
        )}

        {item.decisionComment && (
          <section className="mt-10">
            <h2 className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">Your feedback</h2>
            <blockquote className="mt-4 border-l-2 border-primary/40 pl-4 text-[15px] leading-[1.6] whitespace-pre-wrap text-body">
              {item.decisionComment}
            </blockquote>
          </section>
        )}

        {pending && (
          <section className="mt-10">
            <div className="grid gap-2">
              <Label htmlFor="feedback">Feedback</Label>
              <p id="feedback-hint" className="text-[13px] text-muted-foreground">
                Required to request changes; optional when you approve or deny.
              </p>
              <Textarea
                ref={feedbackRef}
                id="feedback"
                value={comment}
                onChange={(event) => {
                  setComment(event.target.value);
                  if (feedbackError && event.target.value.trim()) setFeedbackError("");
                }}
                maxLength={4000}
                aria-invalid={feedbackError ? true : undefined}
                aria-describedby={feedbackError ? "feedback-hint feedback-error" : "feedback-hint"}
                className="min-h-[90px] scroll-mb-40"
                placeholder="What should the agent know about your answer?"
              />
              {feedbackError && (
                <p id="feedback-error" role="alert" className="text-[13px] text-destructive">
                  {feedbackError}
                </p>
              )}
            </div>
          </section>
        )}

        {/* Everything the request filed, kept verbatim for whoever needs to inspect it.
            This is the only place on the screen where mono is allowed. */}
        <details className="group mt-12">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12px] text-muted-foreground transition-colors select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
            Technical details
          </summary>
          <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
            <dl className="grid grid-cols-[minmax(90px,auto)_1fr] gap-x-6 divide-y divide-border">
              <Field label="action">{actionName(item.action)}</Field>
              <Field label="kind">{item.action.kind}</Field>
              {isToolCallAction(item.action) ? (
                <>
                  <Field label="tool">{item.action.toolName}</Field>
                  <Field label="call ID">{item.action.callId}</Field>
                </>
              ) : (
                <>
                  <Field label="version">{item.action.version}</Field>
                  <Field label="audience">{item.action.audience}</Field>
                  {item.action.resourceVersion && <Field label="resource">{item.action.resourceVersion}</Field>}
                </>
              )}
              <Field label="enforcement">{item.enforcement}</Field>
              {item.actionDigest && <Field label="action digest">{item.actionDigest}</Field>}
              {item.manifestDigest && <Field label="manifest digest">{item.manifestDigest}</Field>}
              {item.reviewDigest && <Field label="review digest">{item.reviewDigest}</Field>}
              {item.supersedesApprovalId && <Field label="revises">{item.supersedesApprovalId}</Field>}
              {item.supersededByApprovalId && <Field label="revised by">{item.supersededByApprovalId}</Field>}
            </dl>

            <p className="mt-4 text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">Input</p>
            <pre className="mt-2 overflow-x-auto rounded-lg border border-border bg-muted p-3 font-mono text-[12px] leading-[1.75]">
              {JSON.stringify(item.action.input, null, 2)}
            </pre>

            {item.artefacts.length > 0 && (
              <>
                <p className="mt-4 text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">
                  Attachment hashes
                </p>
                <ul className="mt-2 grid gap-1">
                  {item.artefacts.map((file) => (
                    <li key={file.id} className="font-mono text-[11px] break-all text-muted-foreground">
                      {file.filename} · {file.mediaType} · sha256 {file.sha256}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {item.receipt && (
              <>
                <p className="mt-4 text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">
                  Signed receipt
                </p>
                <p className="mt-2 text-[12px] leading-[1.6] text-muted-foreground">
                  Hand this to whatever performs the action. It verifies against exactly what you reviewed.
                </p>
                <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-[11px] leading-[1.7] break-all whitespace-pre-wrap">
                  {item.receipt}
                </pre>
              </>
            )}
          </div>
        </details>
      </div>

      {pending && (
        <div className="sticky bottom-0 border-t border-border bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
          {/* The bottom padding clears the home indicator on notched phones; the
              viewport is set to viewport-fit=cover so the inset variable is live. */}
          <div className="mx-auto w-[min(760px,100%-2.5rem)] pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            {error && (
              <p role="alert" aria-live="polite" className="mb-3 text-[13px] text-destructive">
                {error}
              </p>
            )}
            <DecisionButtons busy={busy} onDecide={(decision) => void decide(decision)} />
          </div>
        </div>
      )}
    </div>
  );
}
