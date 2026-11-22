import { Missing } from "@/components/market/reference-price";
import { CheckIcon, WarningIcon } from "@/components/ui/icons";
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
import { StatusTag } from "@/components/ui/tag";
import { formatCount, formatPercent, formatUtcDate, shortenAddress, shortenHash, toIsoInstant } from "@/lib/format";
import { largestWeightBps, weightingLabel } from "@/lib/indexes/methodology";
import type { IndexSummary, IndexVersionView } from "@/server/registry";

/** Whether a version passes every check, in words: `5 of 5 checks`, or the check that failed. */
export function VerificationState({ view }: { view: IndexVersionView }) {
  const { checks } = view.verification;
  const failed = checks.find(({ status }) => status === "fail");
  if (view.conformant || failed === undefined) {
    return (
      <span className="inline-flex items-center gap-1">
        <CheckIcon className="shrink-0 text-secondary" />
        {checks.length} of {checks.length} checks
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-negative">
      <WarningIcon className="shrink-0" />
      Fails {failed.id}
    </span>
  );
}

function IndexRow({ index }: { index: IndexSummary }) {
  const { head, latest, identifier } = index;
  const spec = latest.conformant ? latest.spec : null;
  return (
    <TableRow>
      <TableRowHeader>
        <span className="flex items-center gap-2">
          <Link href={`/indexes/${identifier}`} variant="quiet">
            {spec === null ? (
              <>
                Unverified index <span className="font-mono text-sm font-normal">{shortenHash(head.indexId)}</span>
              </>
            ) : (
              spec.name
            )}
          </Link>
          {head.deprecatedAt === null ? null : <StatusTag status="Deprecated" />}
        </span>
      </TableRowHeader>
      <TableCell className="font-mono text-sm text-secondary">
        <span title={head.creator}>{shortenAddress(head.creator)}</span>
      </TableCell>
      <TableCell>{spec === null ? <Missing /> : weightingLabel(spec)}</TableCell>
      <TableCell numeric>{spec === null ? <Missing /> : formatCount(BigInt(latest.constituents.length))}</TableCell>
      <TableCell numeric>
        {spec === null ? <Missing /> : formatPercent(BigInt(largestWeightBps(latest.constituents)))}
      </TableCell>
      <TableCell numeric>v{latest.version}</TableCell>
      <TableCell className="num text-secondary">
        <time dateTime={toIsoInstant(latest.publishedAt)}>{formatUtcDate(latest.publishedAt)}</time>
      </TableCell>
      <TableCell>
        <VerificationState view={latest} />
      </TableCell>
    </TableRow>
  );
}

type ExplorerTableProps = {
  indexes: readonly IndexSummary[];
  /** Number of indexes in the registry, of which `indexes` is one page. */
  total: number;
  newestFirst: boolean;
  /** Path of the API request that returns the rows of this table. */
  apiHref: string;
};

/**
 * The published indexes as a table. An index whose latest version fails verification keeps its row, with its
 * state and none of the values that would come from its spec.
 */
export function ExplorerTable({ indexes, total, newestFirst, apiHref }: ExplorerTableProps) {
  return (
    <Table label="Published indexes">
      <TableCaption>
        <span>Published indexes</span>
        <span className="num font-normal text-secondary">{formatCount(BigInt(total))}</span>
        <span className="text-sm font-normal text-secondary">{newestFirst ? "Newest first" : "Oldest first"}</span>
        <Link href={apiHref} className="text-sm font-normal">
          JSON
        </Link>
      </TableCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Index</TableHeader>
          <TableHeader>Creator</TableHeader>
          <TableHeader>Weighting</TableHeader>
          <TableHeader numeric>Constituents</TableHeader>
          <TableHeader numeric>Largest weight</TableHeader>
          <TableHeader numeric>Version</TableHeader>
          <TableHeader>Published (UTC)</TableHeader>
          <TableHeader>Verification</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {indexes.map((index) => (
          <IndexRow key={index.head.indexId} index={index} />
        ))}
      </TableBody>
    </Table>
  );
}
