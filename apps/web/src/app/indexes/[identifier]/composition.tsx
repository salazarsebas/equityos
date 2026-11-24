import { marketPhaseAt } from "@equityos/core";
import {
  INELIGIBILITY_LABELS,
  Missing,
  oldestUpdate,
  PRICE_DECIMALS,
  PriceStatus,
  tokenExplorerUrl,
} from "@/components/market/reference-price";
import { Callout } from "@/components/ui/callout";
import { Link } from "@/components/ui/link";
import { Skeleton } from "@/components/ui/skeleton";
import { SourceLine } from "@/components/ui/source-line";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFoot,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "@/components/ui/table";
import { StatusTag } from "@/components/ui/tag";
import { formatCount, formatPercent, formatPrice, formatUtcDateTime, shortenAddress } from "@/lib/format";
import { largestWeightBps } from "@/lib/indexes/methodology";
import { type CompositionRow, constituentStatus, joinComposition } from "@/server/indexes";
import { type MarketSnapshot, marketDataMode } from "@/server/market";
import type { IndexVersionView } from "@/server/registry";
import { FixedCaption } from "../fixed-caption";

/** The market data a profile joins its constituents with, or `null` when it could not be loaded. */
export type SnapshotResult = Promise<MarketSnapshot | null>;

/** Everything that is true of a constituent now and worth a flag, in words. Empty when nothing is. */
function statusFlags(row: CompositionRow): string[] {
  const { eligible, ineligibleReasons, transfersPaused, priced } = constituentStatus(row);
  return [
    ...(eligible
      ? []
      : [`Not eligible now: ${ineligibleReasons.map((reason) => INELIGIBILITY_LABELS[reason]).join(", ")}`]),
    ...(transfersPaused === true ? ["Transfers paused"] : []),
    ...(eligible && !priced ? ["No usable price"] : []),
  ];
}

/** Width of a weight bar relative to the largest weight, as a CSS percentage with two decimals. */
function barWidth(weightBps: number, largestBps: number): string {
  const hundredths = (BigInt(weightBps) * 10_000n) / BigInt(largestBps);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}%`;
}

function ConstituentRow({ row, largestBps, known }: { row: CompositionRow; largestBps: number; known: boolean }) {
  const { token, weightBps, market } = row;
  const price = market?.referencePrice ?? null;
  const flags = statusFlags(row);
  return (
    <TableRow>
      <TableRowHeader className="font-mono text-sm">{market?.asset.symbol ?? shortenAddress(token)}</TableRowHeader>
      <TableCell className="max-w-36 truncate text-secondary md:max-w-56" title={market?.asset.name}>
        {market ? market.asset.name : <Missing />}
      </TableCell>
      <TableCell numeric>{formatPercent(BigInt(weightBps))}</TableCell>
      <TableCell aria-hidden="true" className="w-24 pl-0">
        <span className="block h-1.5 w-24">
          <span className="block h-full bg-(--border-strong)" style={{ width: barWidth(weightBps, largestBps) }} />
        </span>
      </TableCell>
      <TableCell numeric>
        {price !== null && price.status !== "unavailable" ? formatPrice(price.priceE8, PRICE_DECIMALS) : <Missing />}
      </TableCell>
      <TableCell>{price ? <PriceStatus price={price} /> : <Missing />}</TableCell>
      <TableCell className={flags.length > 0 ? "text-warning" : "text-secondary"}>
        {known ? flags.length > 0 ? flags.join(" · ") : "Eligible" : <Missing />}
      </TableCell>
      <TableCell className="font-mono text-sm text-secondary">
        <Link href={tokenExplorerUrl(token)} variant="quiet" aria-label={`${shortenAddress(token)}, token ${token}`}>
          <span title={token}>{shortenAddress(token)}</span>
        </Link>
      </TableCell>
    </TableRow>
  );
}

/**
 * The constituents of a verified version with their target weights, next to the reference price and the status
 * of each token now. When the market data cannot be loaded the weights are still shown: they come from the
 * registry and do not depend on it.
 */
export async function Composition({ view, snapshot }: { view: IndexVersionView; snapshot: SnapshotResult }) {
  const market = await snapshot;
  const joined: CompositionRow[] = market
    ? joinComposition(view.constituents, market)
    : view.constituents.map((constituent) => ({ ...constituent, market: null }));
  // Largest weight first. Equal weights keep the published order, ascending token address.
  const rows = [...joined].sort((a, b) => b.weightBps - a.weightBps || (a.token < b.token ? -1 : 1));
  const largestBps = largestWeightBps(rows);
  const total = rows.reduce((sum, { weightBps }) => sum + BigInt(weightBps), 0n);
  const title = `Composition of version ${view.version}`;
  const apiHref = `/api/v1/indexes/${view.indexId}/composition?version=${view.version}`;

  return (
    <div className="flex flex-col gap-3">
      {market === null ? (
        <Callout tone="warning" title="Reference prices and the current status of the tokens could not be loaded.">
          A market data source did not answer. The target weights below come from the registry and are complete. Prices
          and status are left out, not estimated.
        </Callout>
      ) : null}
      {market !== null && marketDataMode() === "replay" ? (
        <Callout tone="warning" title="Reference prices are a recording, not current data.">
          They were read at Base mainnet block {formatCount(market.onchain.blockNumber)} on{" "}
          {formatUtcDateTime(BigInt(market.onchain.blockTimestamp))} and are replayed for testing.
        </Callout>
      ) : null}
      <Table label={title}>
        <TableCaption>
          <span>{title}</span>
          <StatusTag status="Reference" />
          {market !== null && marketPhaseAt(market.observedAt) === "closed" ? (
            <StatusTag status="Market closed" />
          ) : null}
          <Link href={apiHref} className="text-sm font-normal">
            JSON
          </Link>
        </TableCaption>
        <TableHead>
          <TableRow>
            <TableHeader>Asset</TableHeader>
            <TableHeader>Name</TableHeader>
            <TableHeader numeric>Target weight</TableHeader>
            <TableHeader aria-hidden="true" className="pl-0" />
            <TableHeader numeric>Reference price (USD)</TableHeader>
            <TableHeader>Price status</TableHeader>
            <TableHeader>Status now</TableHeader>
            <TableHeader>Token</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <ConstituentRow key={row.token} row={row} largestBps={largestBps} known={market !== null} />
          ))}
        </TableBody>
        <TableFoot>
          <TableRow>
            <TableRowHeader>Total</TableRowHeader>
            <TableCell />
            <TableCell numeric>{formatPercent(total)}</TableCell>
            <TableCell colSpan={5} />
          </TableRow>
        </TableFoot>
      </Table>
      {market === null ? null : (
        <SourceLine
          label="Reference prices"
          source={`Chainlink feeds, Base mainnet block ${formatCount(market.onchain.blockNumber)}`}
          asOfUnixSeconds={BigInt(
            oldestUpdate(rows.flatMap(({ market: entry }) => entry ?? [])) ?? market.onchain.blockTimestamp,
          )}
          note="oldest value shown"
          {...(market.onchain.servedStale ? { stale: "source not answering" } : {})}
        />
      )}
      <FixedCaption />
    </div>
  );
}

/** The frame of the composition table while the market data loads, with the number of rows it will have. */
export function CompositionSkeleton({ view }: { view: IndexVersionView }) {
  return (
    <>
      <noscript>
        <Callout title="The composition table needs JavaScript.">
          The same data is available without it as JSON:{" "}
          <Link href={`/api/v1/indexes/${view.indexId}/composition?version=${view.version}`}>
            composition of version {view.version}
          </Link>
          .
        </Callout>
      </noscript>
      <div aria-busy="true" className="mt-3 overflow-hidden rounded-lg border bg-surface">
        <span className="sr-only">Loading the composition</span>
        <div className="border-b px-4 py-3">
          <Skeleton className="h-5 w-56" />
        </div>
        <div className="h-8 border-b bg-subtle" />
        {view.constituents.map(({ token }) => (
          <div key={token} className="flex h-9 items-center gap-6 border-b px-4">
            <Skeleton className="w-14 shrink-0" />
            <Skeleton className="w-40 shrink-0" />
            <Skeleton className="w-32 shrink-0" />
            <Skeleton className="w-20 shrink-0" />
          </div>
        ))}
        <div className="h-9" />
      </div>
    </>
  );
}

function countOf(amount: number, total: number): string {
  return `${amount} of ${total} ${total === 1 ? "constituent" : "constituents"}`;
}

/**
 * The time-dependent counterpart of the checks: whether the constituents are, at this block, still eligible,
 * transferable and priced. It is reported next to the verification and never counted as part of it.
 */
export async function CurrentStatus({ view, snapshot }: { view: IndexVersionView; snapshot: SnapshotResult }) {
  const market = await snapshot;
  if (market === null) {
    return <p className="text-warning">Not checked: the market data could not be loaded.</p>;
  }
  const statuses = joinComposition(view.constituents, market).map(constituentStatus);
  const total = statuses.length;
  const ineligible = statuses.filter(({ eligible }) => !eligible).length;
  const paused = statuses.filter(({ transfersPaused }) => transfersPaused === true).length;
  const unpriced = statuses.filter(({ eligible, priced }) => eligible && !priced).length;
  const problems = [
    ...(ineligible > 0 ? [`${countOf(ineligible, total)} not index-eligible now`] : []),
    ...(paused > 0 ? [`${countOf(paused, total)} with transfers paused`] : []),
    ...(unpriced > 0 ? [`${countOf(unpriced, total)} without a usable reference price`] : []),
  ];
  return (
    <div data-testid="current-status">
      {problems.length === 0 ? (
        <p>
          {total === 1 ? "The constituent is" : `All ${total} constituents are`} index-eligible, transferable and{" "}
          {total === 1 ? "has" : "have"} a usable reference price.
        </p>
      ) : (
        <p className="font-medium text-warning">{problems.join(". ")}. The composition table marks each one.</p>
      )}
      <p className="mt-1 text-xs text-secondary">
        Read from Base mainnet at block <span className="num">{formatCount(market.onchain.blockNumber)}</span>,{" "}
        {formatUtcDateTime(BigInt(market.onchain.blockTimestamp))}. Not part of the checks above.
      </p>
    </div>
  );
}
