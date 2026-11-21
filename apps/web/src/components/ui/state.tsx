import type { ReactNode } from "react";
import { WarningIcon } from "./icons";

type StateProps = {
  title: string;
  children: ReactNode;
  /** The next step, as a Button or Link. */
  action?: ReactNode;
};

function StateFrame({ title, children, action, icon }: StateProps & { icon?: ReactNode }) {
  return (
    <div className="rounded-lg border bg-surface px-4 py-6">
      <p className="flex items-center gap-2 font-medium text-primary">
        {icon}
        {title}
      </p>
      <div className="mt-1 max-w-measure text-secondary">{children}</div>
      {action ? <div className="mt-4 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

/** A region with nothing to show yet. Says why it is empty and when or how it fills. No illustration. */
export function EmptyState(props: StateProps) {
  return <StateFrame {...props} />;
}

/**
 * A region that failed. The text says what happened, what state the user's data or assets are in, and what to do
 * next, in that order. It replaces the region: a failed table is never rendered as an empty table.
 */
export function ErrorState(props: StateProps) {
  return (
    <div role="alert">
      <StateFrame {...props} icon={<WarningIcon className="shrink-0 text-negative" />} />
    </div>
  );
}
