import type { ApprovalState, InputState } from "@mayi/contracts";
import { cn } from "~/lib/utils";

/*
/*
 * The states are told apart by weight rather than by hue, because the palette has one
 * accent and inventing a second (a green "approved") would break the rule the
 * marketing page sets. So:
 *   PENDING   indigo, and the only one that moves — it is being held right now.
 *   APPROVED  ink. Settled, not celebratory. The answer is a fact, not a win.
 *   DENIED    the one red on the site. A refusal is the only thing worth alarming for.
 *   the rest   grey. Nothing was decided; nothing needs attention.
 *
 * PENDING's label reads as ink rather than indigo, because the blue is 2.25:1 as text
 * on charcoal (see --primary-ink). In dark mode that makes its label the same colour as
 * APPROVED's, so the two are separated by the indigo tint and border it keeps, and by
 * the breathing dot — which APPROVED does not have. Motion and tint carry the state
 * there, not the glyph colour.
 */
const TONE: Record<ApprovalState | InputState, string> = {
  PENDING: "border-primary/25 bg-primary/8 text-primary-ink",
  APPROVED: "border-foreground/20 bg-foreground/6 text-foreground",
  // An answered question settles the same way an approval does: a fact, not a win.
  ANSWERED: "border-foreground/20 bg-foreground/6 text-foreground",
  DENIED: "border-destructive/30 bg-destructive/8 text-destructive",
  EXPIRED: "border-border bg-muted text-muted-foreground",
  CANCELLED: "border-border bg-muted text-muted-foreground",
  DRAFT: "border-border bg-muted text-muted-foreground",
};

export function StateBadge({ state, className }: { state: ApprovalState | InputState; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] tracking-[0.06em] uppercase",
        TONE[state],
        className,
      )}
    >
      {state === "PENDING" && (
        <span className="relative grid size-1.5 place-items-center" aria-hidden="true">
          <span className="absolute size-1.5 animate-ring rounded-full bg-primary" />
          <span className="size-1.5 animate-breathe rounded-full bg-primary" />
        </span>
      )}
      {state}
    </span>
  );
}
