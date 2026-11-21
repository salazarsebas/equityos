import type { ReactNode } from "react";
import { cx } from "./cx";

export type Tone = "neutral" | "info" | "positive" | "negative" | "warning";

const tones: Record<Tone, string> = {
  neutral: "border-default bg-subtle text-secondary",
  info: "border-info/30 bg-info-subtle text-info",
  positive: "border-positive/30 bg-positive-subtle text-positive",
  negative: "border-negative/30 bg-negative-subtle text-negative",
  warning: "border-warning/30 bg-warning-subtle text-warning",
};

/** Small bordered text label. Sentence case, never a pill. */
export function Tag({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * The closed set of status tags. Each one states a fact about the data it is attached to, and a tag appears once
 * per scope: on the table caption, not on every row. Positive and negative tones are reserved for the sign of a
 * return and are never used here.
 */
const statuses = {
  Theoretical: "neutral",
  Actual: "neutral",
  Simulated: "warning",
  "Demo data": "warning",
  "Back-calculated": "neutral",
  Reference: "neutral",
  Quote: "info",
  "Market closed": "neutral",
  Delayed: "warning",
  "Reference index": "neutral",
  Deprecated: "warning",
} as const satisfies Record<string, Tone>;

export type Status = keyof typeof statuses;

export const STATUSES = Object.keys(statuses) as Status[];

export function StatusTag({ status }: { status: Status }) {
  return <Tag tone={statuses[status]}>{status}</Tag>;
}
