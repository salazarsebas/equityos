import type { IndexSpec } from "@equityos/core";
import { Missing } from "@/components/market/reference-price";
import { CopyButton } from "@/components/ui/copy-button";
import { Link } from "@/components/ui/link";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "@/components/ui/table";
import { formatCount, formatUtcDate, formatUtcMinute, shortenHash, toIsoInstant } from "@/lib/format";
import { diffSpecs, summarizeDiff } from "@/lib/indexes/diff";
import { describeMethodology, METHODOLOGY_LIMITS } from "@/lib/indexes/methodology";
import type { IndexVersionView } from "@/server/registry";
import { VerificationState } from "../explorer-table";
import { FixedCaption } from "../fixed-caption";

/** The rules of a verified spec in plain language, generated from its fields with fixed wording. */
export function Methodology({ spec }: { spec: IndexSpec }) {
  return (
    <section aria-labelledby="methodology-heading">
      <h2 id="methodology-heading" className="text-lg font-medium">
        Methodology
      </h2>
      <p className="mt-1 max-w-measure text-secondary">
        Each line below is generated from one field of the published spec, with fixed wording. The spec itself, shown
        under Verification, is the authority.
      </p>
      <dl className="mt-3 rounded-lg border bg-surface">
        {describeMethodology(spec).map(({ rule, value, reading }) => (
          <div
            key={rule}
            className="grid gap-x-6 gap-y-1 border-b px-4 py-3 last:border-b-0 md:grid-cols-[10rem_14rem_1fr]"
          >
            <dt className="font-medium">{rule}</dt>
            <dd className="num">{value}</dd>
            <dd className="max-w-measure text-secondary">{reading}</dd>
          </div>
        ))}
      </dl>
      <h3 className="mt-6 font-medium">What this index does not do</h3>
      <ul className="mt-2 flex max-w-measure list-disc flex-col gap-1 pl-4 text-secondary">
        {METHODOLOGY_LIMITS.map((limit) => (
          <li key={limit}>{limit}</li>
        ))}
      </ul>
      <div className="mt-3">
        <FixedCaption />
      </div>
    </section>
  );
}

/** What a version changed against the one before it, as fixed phrases computed from the two specs. */
function changesOf(version: IndexVersionView, previous: IndexVersionView | undefined): string[] | null {
  if (version.version === 1) return ["First version"];
  // The version before this one is older than the history shown.
  if (previous === undefined) return null;
  if (!version.conformant) return ["Not compared: this version fails verification"];
  if (!previous.conformant) return [`Not compared: version ${previous.version} fails verification`];
  const changes = summarizeDiff(diffSpecs(previous.spec, version.spec));
  return changes.length === 0 ? ["Same methodology, published again"] : changes;
}

type VersionHistoryProps = {
  identifier: string;
  /** Versions in ascending order: the most recent ones when the index has more than the history holds. */
  history: readonly IndexVersionView[];
  /** Number of versions the index has. */
  total: number;
  /** The version the page shows. */
  shown: number;
};

/** Every recent version of the index, newest first, with what each changed and a link to it. */
export function VersionHistory({ identifier, history, total, shown }: VersionHistoryProps) {
  const rows = history.map((version, i) => ({ version, changes: changesOf(version, history[i - 1]) })).reverse();
  return (
    <section aria-labelledby="versions-heading">
      <h2 id="versions-heading" className="text-lg font-medium">
        Version history
      </h2>
      <p className="mt-1 max-w-measure text-secondary">
        A published version never changes. A new version is a new methodology with its own hash, and earlier versions
        stay readable. Changes are computed by comparing the two specs.
      </p>
      <div className="mt-3">
        <Table label="Version history">
          <TableCaption>
            <span>Versions</span>
            <span className="num font-normal text-secondary">
              {history.length < total
                ? `${formatCount(BigInt(history.length))} most recent of ${formatCount(BigInt(total))}`
                : formatCount(BigInt(total))}
            </span>
            <Link href={`/api/v1/indexes/${history[0]?.indexId ?? identifier}`} className="text-sm font-normal">
              JSON
            </Link>
          </TableCaption>
          <TableHead>
            <TableRow>
              <TableHeader>Version</TableHeader>
              <TableHeader>Published (UTC)</TableHeader>
              <TableHeader numeric>Block</TableHeader>
              <TableHeader>Spec hash</TableHeader>
              <TableHeader>Changes from the previous version</TableHeader>
              <TableHeader>Verification</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(({ version, changes }) => (
              <TableRow key={version.version} aria-current={version.version === shown ? "true" : undefined}>
                <TableRowHeader>
                  <Link href={`/indexes/${identifier}/versions/${version.version}`}>v{version.version}</Link>
                  {version.version === shown ? (
                    <span className="ml-2 text-xs font-normal text-secondary">shown</span>
                  ) : null}
                </TableRowHeader>
                <TableCell className="num text-secondary">
                  <time dateTime={toIsoInstant(version.publishedAt)}>{formatUtcMinute(version.publishedAt)}</time>
                </TableCell>
                <TableCell numeric>{formatCount(version.publishedBlock)}</TableCell>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-sm" title={version.specHash}>
                      {shortenHash(version.specHash)}
                    </span>
                    <CopyButton value={version.specHash} label={`Copy spec hash of version ${version.version}`} />
                  </span>
                </TableCell>
                <TableCell className="py-2">
                  {changes === null ? (
                    <Missing />
                  ) : (
                    <ul className="flex min-w-64 flex-col whitespace-normal">
                      {changes.map((change) => (
                        <li key={change}>{change}</li>
                      ))}
                    </ul>
                  )}
                </TableCell>
                <TableCell>
                  <VerificationState view={version} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/**
 * There is no index level history, so no performance is shown and none is estimated or backfilled. The
 * section states what is absent and what it will be computed from, so that its absence is not read as a gap.
 */
export function Performance({ firstPublishedAt }: { firstPublishedAt: bigint }) {
  return (
    <section aria-labelledby="performance-heading">
      <h2 id="performance-heading" className="text-lg font-medium">
        Performance
      </h2>
      <p className="mt-1 max-w-measure text-secondary">
        No performance is shown for this index. An index level is not calculated yet, so there is no history to chart,
        and none is estimated or back-calculated in its place. When a level is calculated it will start at the
        publication of version 1, on{" "}
        <time dateTime={toIsoInstant(firstPublishedAt)} className="num">
          {formatUtcDate(firstPublishedAt)}
        </time>
        , from the reference prices of the constituents at their target weights, without trading costs, and it will be
        labeled as theoretical.
      </p>
    </section>
  );
}
