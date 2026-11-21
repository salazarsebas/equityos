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

/** One line per data region naming its source and its as-of time in UTC. Turns warning-toned when stale. */
export function SourceLine({ label, source, asOfUnixSeconds, stale, note }: SourceLineProps) {
  return (
    <p className={cx("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs", stale ? "text-warning" : "text-secondary")}>
      {stale ? <ClockIcon className="shrink-0" /> : null}
      <span>
        {label}
        {stale ? ` delayed, ${stale}` : ""}: {source}
      </span>
      <span aria-hidden="true">·</span>
      <span>
        as of{" "}
        <time dateTime={toIsoInstant(asOfUnixSeconds)} className="num">
          {formatUtcDateTime(asOfUnixSeconds)}
        </time>
      </span>
      {note ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{note}</span>
        </>
      ) : null}
    </p>
  );
}
