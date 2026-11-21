import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

/** Page width: 1280 px maximum, 32 px side margins, 16 px under 768 px. */
export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mx-auto w-full max-w-content px-4 md:px-8", className)}>{children}</div>;
}

/** The 12-column grid with 24 px gutters. Children place themselves with `col-span-*` utilities. */
export function Grid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("grid grid-cols-12 gap-x-6", className)}>{children}</div>;
}
