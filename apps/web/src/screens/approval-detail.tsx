import { actionName, isToolCallAction, type Approval } from "@mayi/contracts";
import { MayiHttpError, type MayiClient } from "@mayi/sdk";
import { ArrowLeft, FileText } from "lucide-react";
import { useState } from "react";
import { StateBadge } from "~/components/state-badge";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { fileSize, relativeTime } from "~/lib/format";

/*
 * The same rule the marketing page argues: mono is the request as filed — the call,
 * its arguments, the digests, the receipt — and Suisse is a person talking. The
 * agent's explanation is the one field it writes freely, so it is set as prose; every
 * value rendered *from* the request stays in mono.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="py-2 text-[13px] text-muted-foreground">{label}</dt>
      <dd className="py-2 font-mono text-[13px] break-words text-foreground">{children}</dd>
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
        const password = window.prompt("Re-enter your password to decide this high-risk action");
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
    <div className="mx-auto w-[min(760px,100%-3rem)] py-10">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Inbox
      </button>

      <div className="mt-6 flex items-start justify-between gap-6">
        <h1 className="font-mono text-[clamp(1.4rem,3vw,1.9rem)] leading-tight font-medium tracking-[-0.01em]">
          {actionName(item.action)}
        </h1>
        <StateBadge state={item.state} className="mt-1" />
      </div>

      <p className="mt-4 max-w-[58ch] text-[16px] leading-[1.6] text-body">{item.explanation}</p>
      <p className="mt-3 text-[13px] text-muted-foreground">
        {pending ? `Expires ${relativeTime(item.expiresAt)}` : item.decidedAt ? `Decided ${relativeTime(item.decidedAt)}` : null}
      </p>

      <section className="mt-10">
        <h2 className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">The exact action</h2>
        <dl className="mt-4 grid grid-cols-[minmax(90px,auto)_1fr] gap-x-6 divide-y divide-border border-y border-border">
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
          {item.actionDigest && <Field label="digest">{item.actionDigest}</Field>}
        </dl>

        <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-muted p-4 font-mono text-[12px] leading-[1.75]">
          {JSON.stringify(item.action.input, null, 2)}
        </pre>
      </section>

      <section className="mt-10">
        <h2 className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">
          Evidence ({item.artefacts.length})
        </h2>
        {item.artefacts.length ? (
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
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px]">{file.filename}</span>
                    {/* The hash is the point: it is what the receipt binds to. */}
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {file.mediaType} · {fileSize(file.size)} · {file.sha256.slice(0, 16)}…
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-[14px] text-muted-foreground">No evidence attached.</p>
        )}
      </section>

      {item.decisionComment && (
        <section className="mt-10">
          <h2 className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">Your comment</h2>
          <blockquote className="mt-4 border-l-2 border-primary/40 pl-4 text-[15px] leading-[1.6] text-body">
            {item.decisionComment}
          </blockquote>
        </section>
      )}

      {pending && (
        <section className="mt-10 border-t border-border pt-8">
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

          {error && (
            <p role="alert" aria-live="polite" className="mt-3 text-[13px] text-destructive">
              {error}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-3">
            <Button variant="outline" disabled={busy} onClick={() => decide("DENIED")}>
              Deny
            </Button>
            <Button disabled={busy} onClick={() => decide("APPROVED")}>
              Approve
            </Button>
          </div>
        </section>
      )}

      {item.receipt && (
        <section className="mt-10">
          <h2 className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">Signed receipt</h2>
          <p className="mt-3 max-w-[58ch] text-[14px] leading-[1.6] text-body">
            Hand this to whatever performs the action. It verifies against exactly what you reviewed.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-lg border border-border bg-muted p-4 font-mono text-[11px] leading-[1.7] break-all whitespace-pre-wrap">
            {item.receipt}
          </pre>
        </section>
      )}
    </div>
  );
}
