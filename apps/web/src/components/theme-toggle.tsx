import { Moon, Sun } from "lucide-react";
import { Button } from "~/components/ui/button";

/**
 * Presentational only. The click is handled by /theme.js, which delegates from the
 * document on [data-theme-toggle] — the same script and the same listener the
 * marketing site uses, so the two surfaces can never drift apart on what a theme is
 * or where it is stored. Keeping the state in the DOM (the `dark` class) rather than
 * in React also means the icon is correct on first paint, with nothing to hydrate.
 */
export function ThemeToggle() {
  return (
    <Button
      variant="ghost"
      size="icon"
      data-theme-toggle
      aria-label="Switch between light and dark theme"
      className="text-muted-foreground hover:text-foreground"
    >
      <Moon className="size-4 dark:hidden" />
      <Sun className="hidden size-4 dark:block" />
    </Button>
  );
}
