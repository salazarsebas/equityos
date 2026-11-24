import type { ReactNode } from "react";

/** A titled region of a developer page, separated from the previous one by a rule. */
export function Section({
  id,
  title,
  lead,
  rule = true,
  children,
}: {
  id: string;
  title: string;
  lead?: ReactNode;
  /** A rule above the section. Off for the first section of a column, which follows the page lead. */
  rule?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className={rule ? "mt-12 border-t pt-6" : undefined}>
      <h2 id={`${id}-heading`} className="scroll-mt-6 text-lg font-medium">
        {title}
      </h2>
      {lead === undefined ? null : <div className="mt-2 max-w-measure text-secondary">{lead}</div>}
      <div className="mt-4">{children}</div>
    </section>
  );
}
