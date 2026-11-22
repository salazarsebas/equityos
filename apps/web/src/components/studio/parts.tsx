import type { InputHTMLAttributes, ReactNode } from "react";
import { cx } from "@/components/ui/cx";
import { Input } from "@/components/ui/field";
import { CheckIcon, CircleIcon, WarningIcon } from "@/components/ui/icons";
import type { FieldIssue } from "@/lib/studio/evaluate";

/** Complete, steps still to do, or mistakes to fix: the state of one section or of the whole draft. */
export function issueSummary(issues: readonly FieldIssue[]): { tone: "done" | "todo" | "error"; text: string } {
  const errors = issues.filter(({ incomplete }) => !incomplete).length;
  if (errors > 0) return { tone: "error", text: `${errors} ${errors === 1 ? "issue" : "issues"}` };
  return issues.length > 0 ? { tone: "todo", text: "To do" } : { tone: "done", text: "Complete" };
}

/** State of a step in words, with a mark. Color is never the only carrier: the text says it. */
export function StatusMark({ tone, children }: { tone: "done" | "todo" | "error"; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 text-sm whitespace-nowrap",
        tone === "error" ? "text-negative" : "text-secondary",
      )}
    >
      {tone === "done" ? <CheckIcon /> : tone === "error" ? <WarningIcon /> : <CircleIcon />}
      {children}
    </span>
  );
}

type SectionProps = {
  number: number;
  title: string;
  /** One sentence on what this part of the index decides. */
  lead: string;
  issues: readonly FieldIssue[];
  children: ReactNode;
};

/** One numbered part of the editor, with its state next to the title. Parts are separated by a rule, not a box. */
export function Section({ number, title, lead, issues, children }: SectionProps) {
  const { tone, text } = issueSummary(issues);
  const id = `studio-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="border-t pt-6 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id={id} className="text-lg font-medium">
          <span className="num mr-2 text-tertiary">{number}</span>
          {title}
        </h2>
        <StatusMark tone={tone}>{text}</StatusMark>
      </div>
      <p className="mt-1 max-w-measure text-secondary">{lead}</p>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** Hint or error of a `Field`, from the issues of that field: a blank field asks, a wrong one is marked. */
export function fieldMessage(issues: readonly FieldIssue[], hint?: string): { hint?: string; error?: string } {
  const [first] = issues;
  if (first === undefined) return hint === undefined ? {} : { hint };
  return first.incomplete ? { hint: first.message } : { error: first.message };
}

/** A number typed as text with its unit after it. Decimal keypad on touch devices, right-aligned figures. */
export function UnitInput({ unit, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { unit: string }) {
  return (
    <div className={cx("relative", className)}>
      <Input inputMode="decimal" autoComplete="off" {...rest} className="num pr-8 text-right" />
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-sm text-secondary">
        {unit}
      </span>
    </div>
  );
}
