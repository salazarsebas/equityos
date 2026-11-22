import type { ReactNode } from "react";
import { cx } from "./cx";

type StatProps = {
  label: ReactNode;
  /** A formatted string. Pass the missing-value dash when there is no value, never a zero. */
  value: string;
  /** Trailing unit when the value has one, in secondary color: "USD", "pp". */
  unit?: string;
  /** Color for the sign of a return. The value must already carry an explicit + or minus sign. */
  tone?: "positive" | "negative";
};

/** One label and value pair of a stats row. Not a card: cells are separated by hairlines only. */
export function Stat({ label, value, unit, tone }: StatProps) {
  return (
    <div className="flex flex-col border-t border-l px-4 py-3">
      <dt className="flex h-6 items-center gap-2 text-xs text-secondary">{label}</dt>
      <dd
        className={cx(
          "num text-lg font-medium",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
        )}
      >
        {value}
        {unit ? <span className="ml-1 text-sm font-normal text-secondary">{unit}</span> : null}
      </dd>
    </div>
  );
}

const columnClasses = {
  4: "grid-cols-2 lg:grid-cols-4",
  6: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
} as const;

type StatGridProps = {
  children: ReactNode;
  /** Number of stats in one row on a wide screen. Defaults to 6. */
  columns?: keyof typeof columnClasses;
  className?: string;
};

/**
 * A row of stats that wraps on narrow screens. Every cell draws its top and left rule and the grid is shifted by
 * one pixel under a clipping frame, so rules appear only between cells however the row wraps.
 */
export function StatGrid({ children, columns = 6, className }: StatGridProps) {
  return (
    <div className="overflow-hidden border-y">
      <dl className={cx("-mt-px -ml-px grid", columnClasses[columns], className)}>{children}</dl>
    </div>
  );
}
