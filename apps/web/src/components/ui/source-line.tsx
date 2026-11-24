import type { ReactNode } from "react";
import { formatUtcDateTime, toIsoInstant } from "@/lib/format";
import { cx } from "./cx";
import { ClockIcon } from "./icons";

type SourceLineProps = {
  /** What the data is: "Reference prices". */
  label: string;
  /** Who published it. */
  source: string;
  /** Time of the snapshot the whole region was calculated from, in Unix seconds. */
  asOfUnixSeconds: bigint;
  /** Set when the snapshot is older than its expected update interval. States the delay: "oldest 14 min". */
  stale?: string;
  /** A neutral qualifier such as "Market closed". */
  note?: string;
};

/**
 * A part of the line. Each part draws its separator in its own left padding, and the line is shifted left by that
 * padding inside a frame that clips it: so the separator shows between parts and is hidden on the part that starts
 * a line, whether it is the first one or one that wrapped. The separator is decoration, kept out of the
 * accessible text.
 */
function Part({ children }: { children: ReactNode }) {
  return (
    <span className="relative pl-4 before:absolute before:left-0 before:w-4 before:text-center before:content-['·'_/_'']">
      {children}
    </span>
  );
}

/** One line per data region naming its source and its as-of time in UTC. Turns warning-toned when stale. */
export function SourceLine({ label, source, asOfUnixSeconds, stale, note }: SourceLineProps) {
  return (
    <p className={cx("overflow-hidden text-xs", stale ? "text-warning" : "text-secondary")}>
      <span className="-ml-4 flex flex-wrap items-center gap-y-1">
        <Part>
          {stale ? <ClockIcon className="mr-2 inline-block shrink-0 align-[-3px]" /> : null}
          {label}
          {stale ? ` delayed, ${stale}` : ""}: {source}
        </Part>
        <Part>
          as of{" "}
          <time dateTime={toIsoInstant(asOfUnixSeconds)} className="num">
            {formatUtcDateTime(asOfUnixSeconds)}
          </time>
        </Part>
        {note ? <Part>{note}</Part> : null}
      </span>
    </p>
  );
}
