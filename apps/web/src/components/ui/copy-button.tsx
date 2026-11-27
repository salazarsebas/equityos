"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { cx } from "./cx";

const subscribe = () => () => {};

type CopyButtonProps = {
  /** The exact text placed on the clipboard. */
  value: string;
  /** Names what is copied, for assistive technology: "Copy spec hash". */
  label: string;
  className?: string;
};

const BUTTON_CLASS =
  "inline-flex h-6 items-center rounded-md border border-strong bg-surface px-2 text-xs font-medium whitespace-nowrap text-primary transition-colors duration-[120ms] hover:bg-subtle pointer-coarse:h-11 pointer-coarse:px-3";

/**
 * Copies a value to the clipboard and confirms it in place. The control appears only once the page is
 * interactive, so a reader without JavaScript never sees a control that does nothing: the value itself is always
 * selectable text. Until then an invisible box of the same size holds its place, so the line it sits on does not
 * wrap differently, and move what follows, when the control appears.
 */
export function CopyButton({ value, label, className }: CopyButtonProps) {
  const interactive = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [state]);

  if (!interactive) {
    return (
      <span
        aria-hidden="true"
        data-copy-placeholder=""
        className={cx("invisible relative inline-flex shrink-0", className)}
      >
        <span className={BUTTON_CLASS}>Copy</span>
      </span>
    );
  }
  const text = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy";
  return (
    // Positioned, so that the visually hidden status stays inside a scrolling ancestor instead of widening the page.
    <span className={cx("relative inline-flex shrink-0", className)}>
      <button
        type="button"
        aria-label={state === "idle" ? label : undefined}
        onClick={() => {
          navigator.clipboard.writeText(value).then(
            () => setState("copied"),
            () => setState("failed"),
          );
        }}
        className={BUTTON_CLASS}
      >
        {text}
      </button>
      <span role="status" className="sr-only">
        {state === "idle" ? "" : text}
      </span>
    </span>
  );
}
