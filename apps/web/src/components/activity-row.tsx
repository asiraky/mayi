import { ChevronRight } from "lucide-react";
import { relativeTime } from "~/lib/format";

/*
 * The plain-language line is for reading; the expander is the app's inspect surface,
 * so the raw event — ids, digests, metadata — lives there, and mono is allowed.
 */
const EVENT_LABELS: Record<string, string> = {
  "approval.requested": "Approval requested",
  "approval.drafted": "Approval drafted",
  "approval.sealed": "Approval sealed",
  "approval.approved": "Approval approved",
  "approval.denied": "Approval denied",
  "approval.expired": "Approval expired",
  "approval.cancelled": "Approval cancelled",
  "input.requested": "Question asked",
  "input.answered": "Question answered",
  "input.expired": "Question expired",
  "input.cancelled": "Question cancelled",
  "auth.step_up": "Identity re-confirmed",
  "agent.created": "Agent connected",
  "agent.revoked": "Agent revoked",
  "agent.consent_granted": "Agent access granted",
  "receipt.consumed": "Receipt consumed",
  "workspace.created": "Workspace created",
  "forwarding.rule_created": "Forwarding rule created",
  "forwarding.email_verified": "Forwarding email verified",
  "forwarding.destination_verified": "Forwarding destination verified",
};

function eventLabel(eventType: string): string {
  const known = EVENT_LABELS[eventType];
  if (known) return known;
  const words = eventType.replace(/[._]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function ActivityRow({ entry }: { entry: Record<string, unknown> }) {
  const technical = {
    eventType: entry.eventType,
    actorType: entry.actorType,
    actorId: entry.actorId,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    metadata: entry.metadata,
  };

  return (
    <details className="group rounded-xl border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-4 select-none [&::-webkit-details-marker]:hidden">
        <span className="grid min-w-0 gap-1">
          <span className="truncate text-[14px] font-medium">{eventLabel(String(entry.eventType))}</span>
          <span className="truncate text-[12px] text-muted-foreground">
            {entry.actorType ? `by ${String(entry.actorType)} · ` : ""}
            {relativeTime(String(entry.createdAt))}
          </span>
        </span>
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-border px-4 py-3">
        <pre className="overflow-x-auto font-mono text-[11px] leading-[1.7] text-muted-foreground">
          {JSON.stringify(technical, null, 2)}
        </pre>
      </div>
    </details>
  );
}
