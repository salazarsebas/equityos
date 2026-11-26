import type { ReactNode } from "react";
import { cx } from "./cx";
import type { Tone } from "./tag";

type CalloutTone = Exclude<Tone, "positive">;

const tones: Record<CalloutTone, string> = {
  neutral: "border-default bg-subtle",
  info: "border-info/30 bg-info-subtle",
  warning: "border-warning/30 bg-warning-subtle",
  negative: "border-negative/30 bg-negative-subtle",
};

const titles: Record<CalloutTone, string> = {
  neutral: "text-primary",
  info: "text-info",
  warning: "text-warning",
  negative: "text-negative",
};

type CalloutProps = {
  title: string;
  children?: ReactNode;
  tone?: CalloutTone;
  /** Use "alert" only for a message that appears in response to an action and needs immediate attention. */
  role?: "note" | "status" | "alert";
};

/** A statement attached to a region: a condition, a limitation or a consequence. The title is a full sentence. */
export function Callout({ title, children, tone = "neutral", role = "note" }: CalloutProps) {
  return (
    <div role={role} className={cx("rounded-md border px-4 py-3 text-base", tones[tone])}>
      <p className={cx("font-medium", titles[tone])}>{title}</p>
      {children ? <div className="mt-1 max-w-measure text-primary [overflow-wrap:anywhere]">{children}</div> : null}
    </div>
  );
}
