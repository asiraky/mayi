import { MAX_INPUT_TEXT_LENGTH, type Input, type InputAnswer } from "@mayi/contracts";
import type { MayiClient } from "@mayiapp/sdk";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import { StateBadge } from "~/components/state-badge";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { relativeTime } from "~/lib/format";

/*
 * The agent's question is the whole point of this screen, so the prompt is the hero
 * and the answer controls sit where the approve/deny bar sits on the decision screen:
 * pinned to the bottom, one thumb away. Same rule as over there — no mono on the
 * primary surface; the only machine data an input carries (the signed answer
 * attestation) lives in the collapsed "Technical details" disclosure.
 */
export function InputDetail({
  item,
  api,
  onBack,
  onRefresh,
}: {
  item: Input;
  api: MayiClient;
  onBack: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [optionId, setOptionId] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = item.state === "PENDING";
  const options = item.options ?? [];

  // Same 30s pulse as the decision screen: enough for minute-level phrasing.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [pending]);

  async function answer(body: InputAnswer) {
    setBusy(true);
    setError("");
    try {
      await api.answerInput(item.id, body);
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Answer failed");
    } finally {
      setBusy(false);
    }
  }

  // The radio list and the freeform field are one question, so choosing one clears
  // the other — what you see selected is exactly what gets submitted.
  const written = text.trim();
  const submitReady = optionId !== "" || written !== "";
  const submit = () => answer(written ? { text: written } : { optionId });

  const answeredOption = item.answer?.optionId
    ? (options.find((option) => option.id === item.answer?.optionId)?.label ?? item.answer.optionId)
    : undefined;

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
            An agent needs your input
          </p>
          {!pending && <StateBadge state={item.state} />}
        </div>

        <h1 className="mt-3 max-w-[52ch] text-[clamp(1.3rem,4.5vw,1.7rem)] leading-[1.45] font-medium tracking-[-0.01em] text-body">
          {item.prompt}
        </h1>

        <p className="mt-4 text-[13px] text-muted-foreground">
          {pending
            ? `Expires ${relativeTime(item.expiresAt)}`
            : item.answeredAt
              ? `Answered ${relativeTime(item.answeredAt)}`
              : item.cancelledAt
                ? `Cancelled ${relativeTime(item.cancelledAt)}`
                : `Expired ${relativeTime(item.expiresAt)}`}
        </p>

        {pending && item.type === "confirmation" && options.some((option) => option.description) && (
          <ul className="mt-8 grid max-w-[58ch] gap-2">
            {options.map(
              (option) =>
                option.description && (
                  <li key={option.id} className="text-[14px] leading-[1.6] text-muted-foreground">
                    <span className="font-medium text-body">{option.label}</span> — {option.description}
                  </li>
                ),
            )}
          </ul>
        )}

        {pending && item.type === "select" && (
          <fieldset className="mt-10">
            <legend className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">
              Pick an answer
            </legend>
            <div className="mt-4 grid gap-2">
              {options.map((option) => (
                <label
                  key={option.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/25",
                    optionId === option.id && "border-primary/50 bg-primary/6",
                  )}
                >
                  <input
                    type="radio"
                    name="answer"
                    value={option.id}
                    checked={optionId === option.id}
                    onChange={() => {
                      setOptionId(option.id);
                      setText("");
                    }}
                    className="mt-1 size-3.5 shrink-0 accent-primary"
                  />
                  <span className="grid min-w-0 gap-1">
                    <span className="text-[14px] leading-[1.4] font-medium">{option.label}</span>
                    {option.description && (
                      <span className="text-[13px] leading-[1.5] text-muted-foreground">{option.description}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>

            {item.allowFreeform && (
              <div className="mt-6 grid gap-2">
                <Label htmlFor="freeform">Or write your own answer</Label>
                <Textarea
                  id="freeform"
                  value={text}
                  onChange={(event) => {
                    setText(event.target.value);
                    if (event.target.value.trim()) setOptionId("");
                  }}
                  maxLength={MAX_INPUT_TEXT_LENGTH}
                  className="min-h-[90px]"
                  placeholder="Answer in your own words."
                />
              </div>
            )}
          </fieldset>
        )}

        {pending && item.type === "text" && (
          <section className="mt-10">
            <div className="grid gap-2">
              <Label htmlFor="freeform">Your answer</Label>
              <Textarea
                id="freeform"
                value={text}
                onChange={(event) => setText(event.target.value)}
                maxLength={MAX_INPUT_TEXT_LENGTH}
                className="min-h-[120px]"
                placeholder="Answer in your own words."
              />
            </div>
          </section>
        )}

        {!pending && item.answer && (
          <section className="mt-10">
            <h2 className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">The answer</h2>
            {answeredOption && <p className="mt-4 text-[15px] leading-[1.6] font-medium text-body">{answeredOption}</p>}
            {item.answer.text && (
              <blockquote
                className={cn(
                  "border-l-2 border-primary/40 pl-4 text-[15px] leading-[1.6] text-body",
                  answeredOption ? "mt-3" : "mt-4",
                )}
              >
                {item.answer.text}
              </blockquote>
            )}
          </section>
        )}

        {item.attestation && (
          /* The signed attestation is the input's receipt-equivalent — and the only
             mono allowed on this screen, kept behind the same disclosure as over on
             the decision screen. */
          <details className="group mt-12">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12px] text-muted-foreground transition-colors select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
              Technical details
            </summary>
            <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
              <p className="text-[11px] font-medium tracking-[0.09em] text-muted-foreground uppercase">Signed answer</p>
              <p className="mt-2 text-[12px] leading-[1.6] text-muted-foreground">
                Hand this to whatever asked the question. It verifies against exactly the answer you gave.
              </p>
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-[11px] leading-[1.7] break-all whitespace-pre-wrap">
                {item.attestation}
              </pre>
            </div>
          </details>
        )}
      </div>

      {pending && (
        <div className="sticky bottom-0 border-t border-border bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
          <div className="mx-auto w-[min(760px,100%-2.5rem)] pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            {error && (
              <p role="alert" aria-live="polite" className="mb-3 text-[13px] text-destructive">
                {error}
              </p>
            )}
            {item.type === "confirmation" ? (
              <div className="flex gap-3">
                {options.map((option) => (
                  <Button
                    key={option.id}
                    size="lg"
                    disabled={busy}
                    variant={
                      option.style === "danger" ? "destructive" : option.style === "primary" ? "default" : "outline"
                    }
                    onClick={() => answer({ optionId: option.id })}
                    className="h-11 min-w-0 flex-1 text-[15px] sm:flex-none sm:px-8"
                  >
                    <span className="truncate">{option.label}</span>
                  </Button>
                ))}
              </div>
            ) : (
              <div className="flex gap-3">
                <Button
                  size="lg"
                  disabled={busy || !submitReady}
                  onClick={submit}
                  className="h-11 flex-1 text-[15px] sm:flex-none sm:px-10"
                >
                  {busy ? "Sending…" : "Submit answer"}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
