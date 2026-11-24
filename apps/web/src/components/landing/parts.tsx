import type { ReactNode } from "react";
import { Container } from "@/components/shell/container";
import { cx } from "@/components/ui/cx";

/**
 * One section of the landing page. It makes one claim: the heading states it and the lead says it in a
 * sentence, then the content proves it. On a wide screen the heading sits in the first four columns and the
 * content in the other eight, so every section starts on the same line.
 */
export function Section({
  id,
  title,
  lead,
  children,
  last = false,
}: {
  id: string;
  title: string;
  lead: ReactNode;
  children: ReactNode;
  /** The last section leaves its bottom space to the footer's own margin. */
  last?: boolean;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className="border-t">
      <Container className={cx("grid grid-cols-12 gap-x-6 gap-y-8 pt-12 md:pt-16", !last && "pb-12 md:pb-16")}>
        <div className="col-span-12 lg:col-span-4">
          <h2 id={`${id}-heading`} className="max-w-measure text-xl font-medium text-balance md:text-2xl">
            {title}
          </h2>
          <p className="mt-3 max-w-measure text-md text-secondary">{lead}</p>
        </div>
        <div className="col-span-12 min-w-0 lg:col-span-8">{children}</div>
      </Container>
    </section>
  );
}

/** A command or a document, exactly as it is run or stored. Long lines wrap so the page never scrolls sideways. */
export function Code({ children }: { children: string }) {
  return (
    <pre className="rounded-md border bg-subtle px-3 py-2 font-mono text-sm break-all whitespace-pre-wrap text-primary">
      <code>{children}</code>
    </pre>
  );
}

/** A numbered step: the number in the margin, a title and its explanation. */
export function Step({
  number,
  title,
  children,
  className,
}: {
  number: number;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <li className={cx("grid grid-cols-[2rem_minmax(0,1fr)] border-t pt-4", className)}>
      <span aria-hidden="true" className="num text-md text-tertiary">
        {number}
      </span>
      <div className="min-w-0">
        <h3 className="text-md font-medium">{title}</h3>
        <div className="mt-1 flex flex-col gap-3 text-base text-secondary">{children}</div>
      </div>
    </li>
  );
}
