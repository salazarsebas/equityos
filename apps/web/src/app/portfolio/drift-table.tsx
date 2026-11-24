import { ClockIcon } from "@/components/ui/icons";
import { Link } from "@/components/ui/link";
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
import { formatFixed, formatPercent, formatPrice, formatTokenQuantity, formatUsd, MISSING } from "@/lib/format";
import type { ApiPosition, ApiPrice } from "@/lib/portfolio/api";
import { driftBar, driftScaleBps } from "@/lib/portfolio/drift-bar";

const E8 = 8;

export function Missing() {
  return <span className="text-tertiary">{MISSING}</span>;
}

/** Signed percentage points from basis points, without the unit: `+15.00`, `−5.00`, `0.00`. */
export function signedPoints(bps: number): string {
  return `${bps > 0 ? "+" : ""}${formatFixed(BigInt(bps), 2, 2)}`;
}

/** The reference price of a row, with a clock marker when it is delayed and the reason when it is unavailable. */
export function PriceCell({ price }: { price: ApiPrice }) {
  if (price.priceE8 === null) return <span className="text-warning">Unavailable</span>;
  const text = formatPrice(BigInt(price.priceE8), E8);
  if (price.status !== "delayed") return text;
  return (
    <span className="inline-flex items-center gap-1 text-warning" title={`Delayed, published ${price.updatedAt}`}>
      <ClockIcon className="shrink-0" />
      {text}
    </span>
  );
}

/** A quiet bar from zero to the drift, on a track centred on zero, with a tick at the threshold on each side. */
function DriftBar({ driftBps, thresholdBps, scaleBps }: { driftBps: number; thresholdBps: number; scaleBps: number }) {
  const bar = driftBar(driftBps, thresholdBps, scaleBps);
  return (
    <span aria-hidden="true" className="relative block h-4 w-24 md:w-32">
      <span className="absolute inset-y-1 w-px bg-(--border-strong)" style={{ left: bar.lowerTick }} />
      <span className="absolute inset-y-1 w-px bg-(--border-strong)" style={{ left: bar.upperTick }} />
      <span className="absolute inset-y-0 left-1/2 w-px bg-(--text-secondary)" />
      <span
        data-beyond={bar.beyond || undefined}
        className="absolute top-1/2 h-1 -translate-y-1/2 bg-(--text-tertiary) data-beyond:bg-(--warning)"
        style={{ left: bar.left, width: bar.width }}
      />
    </span>
  );
}

/** Largest absolute drift first. Rows without a drift follow, largest target weight first. */
function byDrift(a: ApiPosition, b: ApiPosition): number {
  const drift = Math.abs(b.driftBps ?? -1) - Math.abs(a.driftBps ?? -1);
  return drift || b.targetWeightBps - a.targetWeightBps || (a.token < b.token ? -1 : 1);
}

type DriftTableProps = {
  positions: readonly ApiPosition[];
  thresholdBps: number;
  investedValueUsdE8: string | null;
  marketClosed: boolean;
  apiHref: string;
};

/**
 * Target weight against current weight for every constituent, held or not, with the drift in percentage points
 * and a diverging bar. Over and under target are not good or bad, so the bars use the neutral tone inside the
 * threshold and the warning tone beyond it, never the colors of a return. The accent is kept for interaction.
 */
export function DriftTable({ positions, thresholdBps, investedValueUsdE8, marketClosed, apiHref }: DriftTableProps) {
  const rows = [...positions].sort(byDrift);
  const maxAbs = Math.max(0, ...rows.map(({ driftBps }) => Math.abs(driftBps ?? 0)));
  const scaleBps = driftScaleBps(maxAbs, thresholdBps);
  const weighted = rows.every(({ currentWeightBps }) => currentWeightBps !== null);
  const delayed = rows.some(({ referencePrice }) => referencePrice.status === "delayed");
  return (
    <Table label="Drift against the target weights">
      <TableCaption>
        <span>Drift against the target weights</span>
        <StatusTag status="Reference" />
        {marketClosed ? <StatusTag status="Market closed" /> : null}
        {delayed ? <StatusTag status="Delayed" /> : null}
        <span className="text-sm font-normal text-secondary">Largest drift first</span>
        <Link href={apiHref} className="text-sm font-normal">
          JSON
        </Link>
      </TableCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Asset</TableHeader>
          <TableHeader numeric>Target weight</TableHeader>
          <TableHeader numeric>Current weight</TableHeader>
          <TableHeader numeric>Drift (pp)</TableHeader>
          <TableHeader className="pl-0">
            <span className="sr-only">Drift bar, threshold marked</span>
          </TableHeader>
          <TableHeader numeric>Balance (tokens)</TableHeader>
          <TableHeader numeric>Reference price (USD)</TableHeader>
          <TableHeader numeric>Value (USD)</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.token} className={row.balance === "0" ? "text-secondary" : undefined}>
            <TableRowHeader>
              <span className="font-mono text-sm">{row.symbol ?? row.token}</span>
              <span className="ml-2 hidden max-w-48 truncate align-bottom text-sm font-normal text-secondary lg:inline-block">
                {row.name}
              </span>
            </TableRowHeader>
            <TableCell numeric>{formatPercent(BigInt(row.targetWeightBps))}</TableCell>
            <TableCell numeric>
              {row.currentWeightBps === null ? <Missing /> : formatPercent(BigInt(row.currentWeightBps))}
            </TableCell>
            <TableCell
              numeric
              className={
                row.driftBps !== null && Math.abs(row.driftBps) >= thresholdBps ? "font-medium text-primary" : undefined
              }
            >
              {row.driftBps === null ? <Missing /> : signedPoints(row.driftBps)}
            </TableCell>
            <TableCell className="pl-0">
              {row.driftBps === null ? null : (
                <DriftBar driftBps={row.driftBps} thresholdBps={thresholdBps} scaleBps={scaleBps} />
              )}
            </TableCell>
            <TableCell numeric>{formatTokenQuantity(BigInt(row.balance), row.decimals)}</TableCell>
            <TableCell numeric>
              <PriceCell price={row.referencePrice} />
            </TableCell>
            <TableCell numeric>
              {row.valueUsdE8 === null ? <Missing /> : formatUsd(BigInt(row.valueUsdE8), E8)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFoot>
        <TableRow>
          <TableRowHeader>Total</TableRowHeader>
          <TableCell numeric>{formatPercent(10_000n)}</TableCell>
          <TableCell numeric>{weighted ? formatPercent(10_000n) : <Missing />}</TableCell>
          <TableCell colSpan={4} className="text-right font-normal text-secondary">
            Constituents only, without USDC
          </TableCell>
          <TableCell numeric>
            {investedValueUsdE8 === null ? <Missing /> : formatUsd(BigInt(investedValueUsdE8), E8)}
          </TableCell>
        </TableRow>
      </TableFoot>
    </Table>
  );
}
