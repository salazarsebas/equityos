import { cx } from "@/components/ui/cx";
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
import { formatFixed, formatPrice, formatUtcMinute, MISSING, shortenAddress, toIsoInstant } from "@/lib/format";
import type { AssetMarketData, IneligibilityCode, PricePoint, ReferencePrice } from "@/server/market";

/** Decimals of the multiplier (WAD) and of a reference price. */
const MULTIPLIER_DECIMALS = 18;
const PRICE_DECIMALS = 8;
const ONE_SHARE_WAD = 10n ** BigInt(MULTIPLIER_DECIMALS);

const INELIGIBILITY_LABELS: Record<IneligibilityCode, string> = {
  not_listed: "Not listed",
  onchain_read_failed: "Token unreadable",
  not_initialized: "Not initialized",
  decimals_mismatch: "Decimals mismatch",
  not_minted: "Not minted",
  missing_feed: "No feed",
  feed_mismatch: "Feed changed",
};

const STATUS_LABELS: Record<ReferencePrice["status"], string> = {
  live: "Live",
  delayed: "Delayed",
  last_close: "Last close",
  unavailable: "Unavailable",
};

const UNAVAILABLE_LABELS: Record<Extract<ReferencePrice, { status: "unavailable" }>["reason"], string> = {
  feed_read_failed: "feed not readable",
  feed_mismatch: "feed identity changed",
  invalid_round: "invalid round",
  stale_feed: "feed stale",
};

/** Four fixed decimals, so that the column aligns and a multiplier such as 1.0005 is told apart from 1. */
function formatMultiplier(multiplierWad: bigint): string {
  return formatFixed(multiplierWad, MULTIPLIER_DECIMALS, 4);
}

/** Two fixed decimals, so that the column aligns. A minted supply too small to show is `<0.01`, never `0.00`. */
function formatSupply(totalSupply: bigint, decimals: number): string {
  const text = formatFixed(totalSupply, decimals, 2);
  return totalSupply > 0n && text === "0.00" ? "<0.01" : text;
}

function Missing() {
  return <span className="text-tertiary">{MISSING}</span>;
}

function explorerUrl(address: string): string {
  return `https://basescan.org/address/${address}`;
}

/** The round whose publication time is shown: the usable one, or the stale one a feed last published. */
function shownRound(price: ReferencePrice | null): PricePoint | null {
  if (price === null) return null;
  return price.status === "unavailable" ? price.lastObserved : price;
}

/** Publication time of the oldest round the rows show, Unix seconds, or `null` when no row shows one. */
export function oldestUpdate(rows: readonly AssetMarketData[]): number | null {
  const times = rows.flatMap(({ referencePrice }) => shownRound(referencePrice)?.updatedAt ?? []);
  return times.length === 0 ? null : Math.min(...times);
}

function PriceStatus({ price }: { price: ReferencePrice }) {
  const label = STATUS_LABELS[price.status];
  if (price.status === "unavailable") {
    return (
      <span className="text-warning">
        {label}: {UNAVAILABLE_LABELS[price.reason]}
      </span>
    );
  }
  return <span className={price.status === "delayed" ? "text-warning" : "text-secondary"}>{label}</span>;
}

function AssetRow({ entry, showEligibility }: { entry: AssetMarketData; showEligibility: boolean }) {
  const { asset, token, eligibility, referencePrice } = entry;
  const state = token.status === "ok" ? token.state : null;
  const round = shownRound(referencePrice);
  return (
    <TableRow>
      <TableRowHeader className="font-mono text-sm">{asset.symbol}</TableRowHeader>
      <TableCell className="max-w-36 truncate text-secondary md:max-w-48" title={asset.name}>
        {asset.name}
      </TableCell>
      <TableCell numeric>
        {referencePrice !== null && referencePrice.status !== "unavailable" ? (
          formatPrice(referencePrice.priceE8, PRICE_DECIMALS)
        ) : (
          <Missing />
        )}
      </TableCell>
      <TableCell>{referencePrice ? <PriceStatus price={referencePrice} /> : <Missing />}</TableCell>
      <TableCell className="num text-secondary">
        {round ? (
          <time dateTime={toIsoInstant(BigInt(round.updatedAt))}>{formatUtcMinute(BigInt(round.updatedAt))}</time>
        ) : (
          <Missing />
        )}
      </TableCell>
      <TableCell numeric className={cx(state?.multiplierWad === ONE_SHARE_WAD && "text-tertiary")}>
        {state ? formatMultiplier(state.multiplierWad) : <Missing />}
      </TableCell>
      <TableCell numeric>{state ? formatSupply(state.totalSupply, state.decimals) : <Missing />}</TableCell>
      {showEligibility ? (
        <TableCell className={eligibility.eligible ? undefined : "text-secondary"}>
          {eligibility.eligible
            ? "Eligible"
            : eligibility.reasons.map((reason) => INELIGIBILITY_LABELS[reason]).join(" · ")}
        </TableCell>
      ) : null}
      <TableCell className="font-mono text-sm text-secondary">
        <Link href={explorerUrl(asset.address)} variant="quiet" aria-label={`${asset.symbol} token ${asset.address}`}>
          <span title={asset.address}>{shortenAddress(asset.address)}</span>
        </Link>
      </TableCell>
    </TableRow>
  );
}

/** Above this many rows the table scrolls inside its frame, so that its header stays in view. */
const LONG_TABLE_ROWS = 40;

type AssetsTableProps = {
  title: string;
  rows: readonly AssetMarketData[];
  /** Adds the eligibility column. Left out of a view in which every row is eligible. */
  showEligibility: boolean;
  marketClosed: boolean;
  /** Path of the API request that returns the rows of this table. */
  apiHref: string;
};

/** The asset universe as a dense table. Scrolls horizontally on narrow screens with the symbol pinned. */
export function AssetsTable({ title, rows, showEligibility, marketClosed, apiHref }: AssetsTableProps) {
  return (
    <Table label={title} dense {...(rows.length > LONG_TABLE_ROWS ? { maxHeight: "44rem" } : {})}>
      <TableCaption>
        <span>{title}</span>
        <StatusTag status="Reference" />
        {marketClosed ? <StatusTag status="Market closed" /> : null}
        <Link href={apiHref} className="text-sm font-normal">
          JSON
        </Link>
      </TableCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Asset</TableHeader>
          <TableHeader>Name</TableHeader>
          <TableHeader numeric>Reference price (USD)</TableHeader>
          <TableHeader>Price status</TableHeader>
          <TableHeader>Last update (UTC)</TableHeader>
          <TableHeader numeric>Shares per token</TableHeader>
          <TableHeader numeric>Minted (tokens)</TableHeader>
          {showEligibility ? <TableHeader>Eligibility</TableHeader> : null}
          <TableHeader>Token</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((entry) => (
          <AssetRow key={entry.asset.address} entry={entry} showEligibility={showEligibility} />
        ))}
      </TableBody>
    </Table>
  );
}
