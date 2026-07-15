import type { Session } from "@mayi/contracts";
import { useState } from "react";
import { ThemeToggle } from "~/components/theme-toggle";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import type { MayIClient } from "@mayi/sdk";

export function Auth({ api, onDone }: { api: MayIClient; onDone: (session: Session) => void }) {
  const [signup, setSignup] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email"));
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
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.01em]">May I?</h1>
        <p className="mt-2 text-[15px] leading-[1.6] text-body">
          {signup ? "A workspace holds the requests your agents raise, and the receipts you sign." : "Review the exact action before an agent takes it."}
        </p>

        <form onSubmit={submit} className="mt-8 grid gap-4">
          {signup && (
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" autoComplete="name" required />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              minLength={signup ? 8 : 1}
              autoComplete={signup ? "new-password" : "current-password"}
              required
            />
            {signup && (
              <p className="text-[12px] text-muted-foreground">
                At least 8 characters, with a number and a special character.
              </p>
            )}
          </div>

          {/* aria-live so a screen reader hears the failure — it appears without a
              focus change, so nothing else would announce it. */}
          {error && (
            <p role="alert" aria-live="polite" className="text-[13px] text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={busy} className="mt-2 w-full">
            {busy ? "One moment…" : signup ? "Create workspace" : "Sign in"}
          </Button>
        </form>

        <button
          type="button"
          onClick={() => {
            setSignup(!signup);
            setError("");
          }}
          className="mt-6 text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {signup ? "Already have an account? Sign in" : "Create an account"}
        </button>
      </div>
    </main>
  );
}
