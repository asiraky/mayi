import { actionName, isToolCallAction, type Approval } from "@mayi/contracts";
import { MayiHttpError, type MayiClient } from "@mayiapp/sdk";
import { ArrowLeft, Check, ChevronRight, FileText, X } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import { StateBadge } from "~/components/state-badge";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { fileSize, relativeTime } from "~/lib/format";

/*
 * The agent's explanation is the one field it writes for a person, so it is the hero:
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

export function ApprovalDetail({
  item,
  email,
  api,
  onBack,
  onRefresh,
}: {
  item: Approval;
  email: string;
  api: MayiClient;
  onBack: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = item.state === "PENDING";

  // The expiry line is a countdown; let it count. A 30s pulse is enough for the
  // minute-level phrasing relativeTime produces.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [pending]);

  async function decide(decision: "APPROVED" | "DENIED") {
    setBusy(true);
    setError("");
    const body = { decision, ...(comment ? { comment } : {}) };

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
        if (!password) return setBusy(false);
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
      setBusy(false);
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
          {!pending && <StateBadge state={item.state} />}
        </div>

        <h1 className="mt-3 max-w-[52ch] text-[clamp(1.3rem,4.5vw,1.7rem)] leading-[1.45] font-medium tracking-[-0.01em] text-body">
          {item.explanation}
        </h1>

        <p className="mt-4 text-[13px] text-muted-foreground">
          {pending
            ? `Expires ${relativeTime(item.expiresAt)}`
            : item.decidedAt
              ? `Decided ${relativeTime(item.decidedAt)}`
              : item.state === "EXPIRED"
                ? `Expired ${relativeTime(item.expiresAt)}`
                : null}
        </p>

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

        {item.decisionComment && (
          <section className="mt-10">
            <h2 className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">Your comment</h2>
            <blockquote className="mt-4 border-l-2 border-primary/40 pl-4 text-[15px] leading-[1.6] text-body">
              {item.decisionComment}
            </blockquote>
          </section>
        )}

        {pending && (
          <section className="mt-10">
            <div className="grid gap-2">
              <Label htmlFor="comment">Comment (optional)</Label>
              <Textarea
                id="comment"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                maxLength={4000}
                className="min-h-[90px]"
                placeholder="Why you are answering the way you are."
              />
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
            <div className="flex gap-3">
              <Button
                variant="outline"
                size="lg"
                disabled={busy}
                onClick={() => decide("DENIED")}
                className="h-11 flex-1 text-[15px] text-destructive hover:bg-destructive/8 hover:text-destructive sm:flex-none sm:px-8"
              >
                <X className="size-4" />
                Deny
              </Button>
              <Button
                size="lg"
                disabled={busy}
                onClick={() => decide("APPROVED")}
                className="h-11 flex-1 text-[15px] sm:flex-none sm:px-10"
              >
                <Check className="size-4" />
                {busy ? "Deciding…" : "Approve"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
