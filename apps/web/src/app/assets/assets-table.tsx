import {
  INELIGIBILITY_LABELS,
  Missing,
  PRICE_DECIMALS,
  PriceStatus,
  shownRound,
  tokenExplorerUrl,
} from "@/components/market/reference-price";
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
import { formatFixed, formatPrice, formatUtcMinute, shortenAddress, toIsoInstant } from "@/lib/format";
import type { AssetMarketData } from "@/server/market";

/** Decimals of the share multiplier (WAD). */
const MULTIPLIER_DECIMALS = 18;
const ONE_SHARE_WAD = 10n ** BigInt(MULTIPLIER_DECIMALS);

/** Four fixed decimals, so that the column aligns and a multiplier such as 1.0005 is told apart from 1. */
function formatMultiplier(multiplierWad: bigint): string {
  return formatFixed(multiplierWad, MULTIPLIER_DECIMALS, 4);
}

/** Two fixed decimals, so that the column aligns. A minted supply too small to show is `<0.01`, never `0.00`. */
function formatSupply(totalSupply: bigint, decimals: number): string {
  const text = formatFixed(totalSupply, decimals, 2);
  return totalSupply > 0n && text === "0.00" ? "<0.01" : text;
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
        <Link
          href={tokenExplorerUrl(asset.address)}
          variant="quiet"
          aria-label={`${asset.symbol} token ${asset.address}`}
        >
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
