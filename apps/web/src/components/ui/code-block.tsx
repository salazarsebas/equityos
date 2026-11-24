import { CopyButton } from "./copy-button";
import { cx } from "./cx";

type CodeBlockProps = {
  /** The exact text shown and copied. */
  code: string;
  /** What the block holds, shown above it: "Shell", "TypeScript", "Response 200". */
  title: string;
  /** Names the copied value for assistive technology: "curl command" gives "Copy curl command". */
  copyLabel: string;
  /**
   * `wrap` breaks long lines anywhere, for commands and short code. `scroll` keeps each line whole and scrolls
   * inside the block, for JSON, whose indentation carries its structure.
   */
  overflow?: "wrap" | "scroll";
  /** Caps the height so that a long document scrolls inside the block instead of lengthening the page. */
  tall?: boolean;
  className?: string;
};

/**
 * Monospace text with a title bar and a copy control. The block never widens the page: long lines wrap or
 * scroll inside it. A block that can scroll is keyboard focusable, so that it can be scrolled without a pointer.
 */
export function CodeBlock({ code, title, copyLabel, overflow = "wrap", tall = false, className }: CodeBlockProps) {
  const scrolls = overflow === "scroll" || tall;
  return (
    <figure className={cx("min-w-0 rounded-md border bg-subtle", className)}>
      <figcaption className="flex min-h-8 items-center justify-between gap-3 border-b px-3 py-1">
        <span className="text-xs text-secondary">{title}</span>
        <CopyButton value={code} label={`Copy ${copyLabel}`} />
      </figcaption>
      <pre
        tabIndex={scrolls ? 0 : undefined}
        className={cx(
          "overflow-auto px-3 py-2 font-mono text-sm text-primary",
          overflow === "wrap" ? "break-all whitespace-pre-wrap" : "whitespace-pre",
          tall && "max-h-96",
        )}
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}
