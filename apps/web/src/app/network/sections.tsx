import type { ReactNode } from "react";
import { Link } from "@/components/ui/link";
import { Stat } from "@/components/ui/stat";
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
import { formatCount, formatUsd, formatUtcMinute, shortenAddress, shortenHash } from "@/lib/format";
import { explorerTransactionUrl } from "@/lib/indexes/chains";
import {
  type ClassifiedAttestation,
  type IndexLabel,
  METRIC_DEFINITIONS,
  type Metric,
  type MetricId,
  MIN_SERIES_DAYS,
  type NetworkRead,
  spansEnoughDays,
  TIER_B_WINDOW_SECONDS,
  type Tier,
  TOLERANCE_MARGIN_BPS,
} from "@/server/network";
import type { DailyCount } from "@/server/registry";
import { DailyBars } from "./daily-bars";

type Read = Extract<NetworkRead, { status: "ok" }>;

/** Rows of the attestation table. The counts above cover every attestation. */
const LISTED_ATTESTATIONS = 20;

function title(id: MetricId): string {
  return METRIC_DEFINITIONS.find((definition) => definition.id === id)?.title ?? id;
}

/** A stat whose label opens its definition: one click from the figure to the rule that produced it. */
export function MetricStat({ metric, value, unit }: { metric: Metric<unknown>; value: string; unit?: string }) {
  return (
    <Stat
      label={
        <Link href={`#${metric.id}`} variant="quiet">
          {title(metric.id)}
        </Link>
      }
      value={value}
      {...(unit === undefined ? {} : { unit })}
    />
  );
}

/** A count as text, from a metric whose value is a count. */
export function count(metric: Metric<number>): string {
  return formatCount(BigInt(metric.value));
}

export function blockRange(metric: Metric<unknown>): string {
  return metric.toBlock === null
    ? "no block scanned yet"
    : `blocks ${formatCount(metric.fromBlock)} to ${formatCount(metric.toBlock)}`;
}

/** A daily series when it spans enough days to say something, a plain sentence otherwise. */
export function DailySeries({ metric, noun }: { metric: Metric<DailyCount[]>; noun: string }) {
  const series = metric.value;
  if (spansEnoughDays(series)) return <DailyBars title={`${title(metric.id)}, count`} series={series} />;
  const total = series.reduce((sum, { count: day }) => sum + day, 0);
  const first = series[0]?.day;
  const last = series.at(-1)?.day;
  const when =
    first === undefined ? "" : first === last ? ` All fall on ${first}.` : ` They fall between ${first} and ${last}.`;
  return (
    <p className="max-w-measure text-base text-secondary">
      {formatCount(BigInt(total))} {noun} so far.{when} A daily series is drawn once they span at least{" "}
      {MIN_SERIES_DAYS} days.
    </p>
  );
}

export function Region({ title: heading, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t pt-6">
      <div>
        <h2 className="text-lg font-medium">{heading}</h2>
        {lead ? <p className="mt-1 max-w-measure text-base text-secondary">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}

function IndexName({ indexId, label }: { indexId: string; label: IndexLabel | null }) {
  if (label === null) return <span className="font-mono text-sm">{shortenHash(indexId)}</span>;
  return (
    <Link href={`/indexes/${label.identifier}`} variant="quiet">
      {label.name ?? <span className="font-mono text-sm">{shortenHash(indexId)}</span>}
    </Link>
  );
}

export function IndexTable({ read }: { read: Read }) {
  const { byIndex } = read.metrics;
  return (
    <Table label="Indexes by distinct accounts">
      <TableCaption>Indexes by distinct accounts</TableCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Index</TableHeader>
          <TableHeader numeric>Accounts, tier A</TableHeader>
          <TableHeader numeric>Tier A</TableHeader>
          <TableHeader numeric>Tier B</TableHeader>
          <TableHeader numeric>Unmatched</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {byIndex.value.map(({ indexId, label, attestations, accountsTierA }) => (
          <TableRow key={indexId}>
            <TableRowHeader>
              <IndexName indexId={indexId} label={label} />
            </TableRowHeader>
            <TableCell numeric>{formatCount(BigInt(accountsTierA))}</TableCell>
            <TableCell numeric>{formatCount(BigInt(attestations.tierA))}</TableCell>
            <TableCell numeric>{formatCount(BigInt(attestations.tierB))}</TableCell>
            <TableCell numeric>{formatCount(BigInt(attestations.unmatched))}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const TIER_LABELS: Record<Tier, string> = { a: "A", b: "B, linked", unmatched: "Unmatched" };
const REASONS = {
  no_constituent_flows: "no constituent flows",
  below_minimum_notional: "below 1.00 USD",
  price_unavailable: "no reference price",
} as const;

function TierCell({ attestation }: { attestation: ClassifiedAttestation }) {
  const { tier, reason, tracking } = attestation;
  const detail =
    tier === "a"
      ? tracking?.status === "within" || tracking?.status === "outside"
        ? `${tracking.status} tolerance`
        : "tolerance not assessed"
      : reason === null
        ? null
        : REASONS[reason];
  return (
    <span>
      {TIER_LABELS[tier]}
      {detail === null ? null : <span className="text-secondary">, {detail}</span>}
    </span>
  );
}

export function AttestationTable({ read, rows }: { read: Read; rows: readonly ClassifiedAttestation[] }) {
  const labels = new Map(read.metrics.byIndex.value.map(({ indexId, label }) => [indexId, label]));
  const listed = rows.slice(-LISTED_ATTESTATIONS).reverse();
  return (
    <Table label="Most recent attestations">
      <TableCaption>
        Most recent attestations{rows.length > listed.length ? `, ${listed.length} of ${rows.length}` : ""}
      </TableCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Transaction</TableHeader>
          <TableHeader>Block time, UTC</TableHeader>
          <TableHeader>Account</TableHeader>
          <TableHeader>Index</TableHeader>
          <TableHeader>Tier</TableHeader>
          <TableHeader numeric>Reference value, USD</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {listed.map((attestation) => {
          const { event, valueUsdE8 } = attestation;
          const url = explorerTransactionUrl(read.chainId, event.transactionHash);
          const hash = <span className="font-mono text-sm">{shortenHash(event.transactionHash)}</span>;
          return (
            <TableRow key={`${event.transactionHash}:${event.logIndex}`}>
              <TableRowHeader>
                <span title={event.transactionHash}>{url === null ? hash : <Link href={url}>{hash}</Link>}</span>
              </TableRowHeader>
              <TableCell className="num text-secondary">{formatUtcMinute(event.blockTimestamp)}</TableCell>
              <TableCell className="font-mono text-sm" title={event.account}>
                {shortenAddress(event.account)}
              </TableCell>
              <TableCell>
                <IndexName indexId={event.indexId} label={labels.get(event.indexId) ?? null} /> v{event.version}
              </TableCell>
              <TableCell>
                <TierCell attestation={attestation} />
              </TableCell>
              <TableCell numeric>{valueUsdE8 === null ? "None" : formatUsd(valueUsdE8, 8)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function Exclusions({ read }: { read: Read }) {
  const { excludedActivity } = read.metrics;
  const { indexes, versions, attestations } = excludedActivity.value;
  return (
    <div className="flex flex-col gap-3 text-base">
      {read.exclusions.length === 0 ? (
        <p className="max-w-measure text-secondary">
          No account is excluded on this server: the list in{" "}
          <code className="font-mono text-sm">EQUITYOS_EXCLUDED_ACCOUNTS</code> is empty.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {read.exclusions.map(({ address, label }) => (
            <li key={address} className="flex flex-wrap gap-x-3">
              <span className="font-mono text-sm break-all">{address}</span>
              <span className="text-secondary">{label}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="max-w-measure">
        Their activity, counted apart and in no other figure: {formatCount(BigInt(indexes))} indexes,{" "}
        {formatCount(BigInt(versions))} versions, and attestations of tier A {formatCount(BigInt(attestations.tierA))},
        tier B {formatCount(BigInt(attestations.tierB))}, unmatched {formatCount(BigInt(attestations.unmatched))}.
      </p>
    </div>
  );
}

/** Every definition, the thresholds, and what the figures can and cannot be trusted for. */
export function HowTheyAreMade({ chainLabel }: { chainLabel: string }) {
  return (
    <Region
      title="How these numbers are made"
      lead={`Every figure is computed by this server from logs of the registry, the rebalance log and the constituent tokens of the chain it reads, ${chainLabel}, and from reads at the block of each transaction. Connected wallets, page views and API requests are never counted.`}
    >
      <dl className="flex flex-col border-b">
        {METRIC_DEFINITIONS.map(({ id, title: name, definition, source }) => (
          <div
            key={id}
            id={id}
            className="scroll-mt-20 border-t py-3 target:bg-accent-subtle md:grid md:grid-cols-[16rem_minmax(0,42rem)] md:gap-x-6"
          >
            <dt className="font-medium">{name}</dt>
            <dd className="mt-1 text-base md:mt-0">{definition}</dd>
            <dd className="mt-1 text-xs text-secondary md:col-start-2">
              Source: {source}. Id <code className="font-mono">{id}</code>.
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex max-w-measure flex-col gap-2 text-base">
        <h3 className="font-medium">Thresholds and limits</h3>
        <p>
          Minimum value of the flows: 1.00 USD. Tier B window: {String(TIER_B_WINDOW_SECONDS)} seconds. Tolerance: the
          version&apos;s drift threshold plus {TOLERANCE_MARGIN_BPS} basis points. They are fixed in the code, so anyone
          can rerun the classification on the same logs and get the same rows.
        </p>
        <p>
          A reference price is the latest answer of the token&apos;s Chainlink feed at the block, not the price a trade
          executed at. An attestation is a claim by the account that sends it: one with no matching flows reaches no
          headline figure, so recording attestations alone inflates nothing.
        </p>
        <p>
          What the rules cannot tell apart: real transfers made only to be counted, such as tokens moved between two
          accounts of one owner, or wash trades by many funded accounts. They cost gas, fees and capital, and they pass
          every rule above. Distinct accounts are addresses, not people.
        </p>
        <p>
          <Link href="/api/v1/network">The same figures, definitions and attestations as JSON</Link>
        </p>
      </div>
    </Region>
  );
}
