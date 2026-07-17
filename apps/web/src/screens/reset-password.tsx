import { useState } from "react";
import { ReceiptMark } from "~/components/receipt-mark";
import { ThemeToggle } from "~/components/theme-toggle";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { MayiHttpError, type MayiClient } from "@mayiapp/sdk";

/** Reached from the reset email's ?reset=<token> link. The flow works with or
 *  without a session — the token alone authenticates the change. */
export function ResetPassword({
  api,
  token,
  onSuccess,
  onRequestNew,
}: {
  api: MayiClient;
  token: string;
  /** The server revoked every session, so the caller signs the UI out too. */
  onSuccess: () => void;
  /** Clears the reset param and returns to the forgot-password view. */
  onRequestNew: () => void;
}) {
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password"));
    if (password !== String(data.get("confirm"))) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api.passwordResetConfirm({ token, password });
      onSuccess();
    } catch (cause) {
      if (cause instanceof MayiHttpError && cause.status === 400) {
        setExpired(true);
      } else if (cause instanceof MayiHttpError && cause.status === 422) {
        setError("That password is too weak. Use at least 8 characters with a letter, a number and a special character.");
      } else {
        setError(cause instanceof Error ? cause.message : "The password could not be updated");
      }
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
          Set a new password
        </h1>
        <p className="mt-2 text-[15px] leading-[1.6] text-body">
          Choose a new password for your May I? account.
        </p>

        {expired ? (
          <>
            <p role="alert" aria-live="polite" className="mt-8 text-[14px] leading-[1.6] text-body">
              This reset link is invalid or has expired. Request a new one.
            </p>
            <button
              type="button"
              onClick={onRequestNew}
              className="mt-4 py-2 text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Request a new reset link
            </button>
          </>
        ) : (
          <form onSubmit={submit} className="mt-8 grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="password">New password</Label>
              <Input id="password" name="password" type="password" minLength={8} autoComplete="new-password" required className="h-10" />
              <p className="text-[12px] text-muted-foreground">
                At least 8 characters with a letter, a number and a special character.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input id="confirm" name="confirm" type="password" minLength={8} autoComplete="new-password" required className="h-10" />
            </div>

            {/* aria-live so a screen reader hears the failure — it appears without a
                focus change, so nothing else would announce it. */}
            {error && (
              <p role="alert" aria-live="polite" className="text-[13px] text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={busy} className="mt-2 h-11 w-full text-[15px]">
              {busy ? "One moment…" : "Set new password"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
