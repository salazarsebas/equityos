import { cx } from "./cx";

/**
 * Static placeholder for content that is loading. Size it with the exact dimensions of what it replaces so the
 * layout does not shift. It is hidden from assistive technology: mark the loading region with `aria-busy`.
 */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx("block h-3 rounded-sm bg-subtle", className)} />;
}
