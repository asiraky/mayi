import type { Session } from "@mayi/contracts";
import { useState } from "react";
import { ReceiptMark } from "~/components/receipt-mark";
import { ThemeToggle } from "~/components/theme-toggle";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { MayiHttpError, MayiNetworkError, type MayiClient } from "@mayiapp/sdk";

/** Mode toggles must never touch the URL — the OAuth consent flow parks its
 *  return URL in location.search and app.tsx consumes it after sign-in. */
type Mode = "signin" | "signup" | "forgot" | "forgot-sent";

export function Auth({
  api,
  onDone,
  notice,
  initialMode = "signin",
}: {
  api: MayiClient;
  onDone: (session: Session) => void;
  notice?: string | undefined;
  initialMode?: "signin" | "forgot";
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup";

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email"));

    if (mode === "forgot") {
      try {
        await api.passwordResetRequest({ email });
        setMode("forgot-sent");
      } catch (cause) {
        // A 202 (success) is returned whether or not the account exists, so
        // reaching this catch means a genuine failure — a bad email, rate
        // limiting, a transport/server error — none of which leak account
        // existence. Surfacing them all is safe and avoids the trap of telling
        // the user "email sent" when nothing was sent.
        if (cause instanceof MayiHttpError && cause.status === 429) {
          setError("Too many requests. Try again in a minute.");
        } else if (cause instanceof MayiHttpError && cause.status === 422) {
          setError("Enter a valid email address.");
        } else if (cause instanceof MayiNetworkError) {
          setError(cause.message);
        } else {
          setError("Something went wrong. Please try again.");
        }
      } finally {
        setBusy(false);
      }
      return;
    }

    const password = String(data.get("password"));
    try {
      onDone(signup ? await api.signup({ email, password, displayName: String(data.get("name")) }) : await api.signin({ email, password }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="absolute top-6 right-6">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-[380px]">
        <h1 className="flex items-center gap-3 text-[28px] leading-tight font-semibold tracking-[-0.01em]">
          <ReceiptMark className="h-8 w-8" />
          May I?
        </h1>
        <p className="mt-2 text-[15px] leading-[1.6] text-body">
          {mode === "signup"
            ? "A workspace holds the requests your agents raise, and the receipts you sign."
            : mode === "forgot" || mode === "forgot-sent"
              ? "Enter your email and we'll send you a link to reset your password."
              : "Review the exact action before an agent takes it."}
        </p>

        {notice && mode === "signin" && (
          <p aria-live="polite" className="mt-4 text-[13px] text-muted-foreground">
            {notice}
          </p>
        )}

        {mode === "forgot-sent" ? (
          <>
            <p aria-live="polite" className="mt-8 text-[14px] leading-[1.6] text-body">
              If an account exists for that address, we&rsquo;ve emailed a link to reset your password.
            </p>
            <button
              type="button"
              onClick={() => switchMode("signin")}
              className="mt-4 py-2 text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <form onSubmit={submit} className="mt-8 grid gap-4">
              {signup && (
                <div className="grid gap-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" name="name" autoComplete="name" required className="h-10" />
                </div>
              )}
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required className="h-10" />
              </div>
              {mode !== "forgot" && (
                <div className="grid gap-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    minLength={signup ? 8 : 1}
                    autoComplete={signup ? "new-password" : "current-password"}
                    required
                    className="h-10"
                  />
                  {signup && (
                    <p className="text-[12px] text-muted-foreground">
                      At least 8 characters, with a letter, a number and a special character.
                    </p>
                  )}
                  {mode === "signin" && (
                    <button
                      type="button"
                      onClick={() => switchMode("forgot")}
                      className="justify-self-end text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Forgot my password?
                    </button>
                  )}
                </div>
              )}

              {/* aria-live so a screen reader hears the failure — it appears without a
                  focus change, so nothing else would announce it. */}
              {error && (
                <p role="alert" aria-live="polite" className="text-[13px] text-destructive">
                  {error}
                </p>
              )}

              <Button type="submit" disabled={busy} className="mt-2 h-11 w-full text-[15px]">
                {busy ? "One moment…" : mode === "forgot" ? "Email me a reset link" : signup ? "Create workspace" : "Sign in"}
              </Button>
            </form>

            <button
              type="button"
              onClick={() => switchMode(mode === "signin" ? "signup" : "signin")}
              className="mt-4 py-2 text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {mode === "signin" ? "Create an account" : mode === "signup" ? "Already have an account? Sign in" : "Back to sign in"}
            </button>
          </>
        )}
      </div>
    </main>
  );
}
