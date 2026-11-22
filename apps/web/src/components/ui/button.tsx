import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "./cx";

type Variant = "primary" | "secondary" | "ghost" | "destructive";
type Size = "md" | "lg";

const base =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border font-medium whitespace-nowrap transition-colors duration-[120ms] aria-disabled:cursor-not-allowed";

const variants: Record<Variant, string> = {
  primary:
    "border-transparent bg-accent text-accent-fg hover:bg-accent-hover aria-disabled:bg-subtle aria-disabled:text-disabled",
  secondary:
    "border-strong bg-surface text-primary hover:bg-subtle aria-disabled:border-default aria-disabled:bg-surface aria-disabled:text-disabled",
  ghost:
    "border-transparent text-accent hover:bg-accent-subtle aria-disabled:bg-transparent aria-disabled:text-disabled",
  destructive:
    "border-negative bg-surface text-negative hover:bg-negative-subtle aria-disabled:border-default aria-disabled:bg-surface aria-disabled:text-disabled",
};

/** 32 px by default. 40 px is reserved for the single primary action of a page. */
const sizes: Record<Size, string> = {
  md: "h-8 px-3 text-base pointer-coarse:h-11",
  lg: "h-10 px-4 text-base pointer-coarse:h-11",
};

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> & {
  ref?: Ref<HTMLButtonElement>;
  variant?: Variant;
  size?: Size;
  disabled?: boolean;
  /** While true the button stays focusable, ignores clicks and announces itself as busy. */
  loading?: boolean;
  /** Replaces the label while loading. State what is happening: "Requesting quotes". */
  loadingLabel?: ReactNode;
};

/**
 * Disabled and loading buttons use `aria-disabled` instead of the `disabled` attribute so they keep their place
 * in the tab order and screen readers can still reach the label.
 */
export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  disabled = false,
  loading = false,
  loadingLabel,
  className,
  onClick,
  children,
  ...rest
}: ButtonProps) {
  const inactive = disabled || loading;
  return (
    <button
      {...rest}
      type={inactive && type === "submit" ? "button" : type}
      aria-disabled={inactive || undefined}
      aria-busy={loading || undefined}
      onClick={inactive ? undefined : onClick}
      className={cx(base, variants[variant], sizes[size], className)}
    >
      {loading ? (
        <>
          <span
            aria-hidden="true"
            className="size-3 animate-spin rounded-full motion-reduce:animate-none border-[1.5px] border-current border-r-transparent"
          />
          {loadingLabel ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}
