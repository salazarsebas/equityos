"use client";

import { MoonIcon, SunIcon } from "@/components/ui/icons";
import { THEME_STORAGE_KEY } from "@/lib/theme";

/**
 * Switches between the light and dark theme and stores the choice. The current theme lives on <html data-theme>,
 * set before first paint, so this component holds no state and renders the same markup on server and client.
 */
export function ThemeToggle() {
  function toggle() {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode, blocked site data). The choice then lasts for this page only.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Switch color theme"
      className="inline-flex size-8 shrink-0 pointer-coarse:size-11 items-center justify-center rounded-md border border-strong bg-surface text-primary transition-colors duration-[120ms] hover:bg-subtle"
    >
      <MoonIcon className="theme-dark:hidden" />
      <SunIcon className="hidden theme-dark:block" />
    </button>
  );
}
