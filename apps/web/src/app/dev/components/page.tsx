import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Container, Grid } from "@/components/shell/container";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CodeBlock } from "@/components/ui/code-block";
import { cx } from "@/components/ui/cx";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { Link } from "@/components/ui/link";
import { Skeleton } from "@/components/ui/skeleton";
import { SourceLine } from "@/components/ui/source-line";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState, ErrorState } from "@/components/ui/state";
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
import { Tabs } from "@/components/ui/tabs";
import { STATUSES, StatusTag, Tag } from "@/components/ui/tag";
import {
  formatCompact,
  formatCount,
  formatFixed,
  formatPercent,
  formatPercentagePoints,
  formatPrice,
  formatRelativeTime,
  formatSignedPercent,
  formatTokenQuantity,
  formatUsd,
  formatUtcDateTime,
  MISSING,
  shortenAddress,
} from "@/lib/format";
import { DialogDemo } from "./dialog-demo";
import { sampleConstituents, sampleIndex } from "./sample-data";

export const metadata: Metadata = {
  title: "Component reference",
  description: "Every design system component in every state, rendered with sample data.",
  robots: { index: false, follow: false },
};

const colorTokens = [
  ["bg-page", "bg-surface", "bg-subtle", "border", "border-strong"],
  ["text-primary", "text-secondary", "text-tertiary", "text-disabled"],
  ["accent", "accent-hover", "accent-subtle"],
  ["positive", "positive-subtle", "negative", "negative-subtle"],
  ["warning", "warning-subtle", "info", "info-subtle"],
] as const;

const typeScale = [
  ["text-3xl", "44 / 48", "Landing headline"],
  ["text-2xl", "32 / 40", "Landing section heading"],
  ["text-xl", "24 / 32", "Page title"],
  ["text-lg", "20 / 28", "Section heading, stat value"],
  ["text-md", "16 / 24", "Lead paragraph"],
  ["text-base", "14 / 20", "Body, controls, table cells"],
  ["text-sm", "13 / 20", "Dense table cells, secondary text"],
  ["text-xs", "12 / 16", "Captions, source lines, tags, table headers"],
] as const;

const formats = [
  ["Weight", "1500 bps", formatPercent(1_500n)],
  ["Return", "-38 bps", formatSignedPercent(-38n)],
  ["Drift", "321 bps", formatPercentagePoints(321n)],
  ["USD amount", "12480330000, 6 decimals", formatUsd(12_480_330_000n, 6)],
  ["USD under one cent", "4200, 6 decimals", formatUsd(4_200n, 6)],
  ["Price under 1.00", "912400, 6 decimals", formatPrice(912_400n, 6)],
  ["Token quantity", "4203100000000000000, 18 decimals", formatTokenQuantity(sampleIndex.walletQuantityE18, 18)],
  ["Compact, stat rows only", "1248033120000, 6 decimals", formatCompact(sampleIndex.trackedValueUsd6, 6)],
  ["Count", "1204", formatCount(1_204n)],
  ["Timestamp", "1795208400 s", formatUtcDateTime(sampleIndex.asOfUnixSeconds)],
  [
    "Relative time",
    "240 s earlier",
    formatRelativeTime(sampleIndex.asOfUnixSeconds - 240n, sampleIndex.asOfUnixSeconds),
  ],
  ["Address", "20 bytes", shortenAddress(sampleConstituents[0]?.tokenAddress ?? "")],
  ["Missing value", "none", MISSING],
] as const;

/** Color follows the sign and the sign is always written, so the value reads the same without color. */
function signClass(bps: bigint): string | undefined {
  if (bps > 0n) return "text-positive";
  if (bps < 0n) return "text-negative";
  return undefined;
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  const id = title.toLowerCase().replaceAll(" ", "-");
  return (
    <section aria-labelledby={id} className="border-t pt-6">
      <h2 id={id} className="text-lg font-medium">
        {title}
      </h2>
      {note ? <p className="mt-1 max-w-measure text-secondary">{note}</p> : null}
      <div className="mt-4 flex flex-col gap-6">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-12 md:gap-6">
      <p className="text-xs text-secondary md:col-span-2 md:pt-2">{label}</p>
      <div className="flex flex-wrap items-center gap-3 md:col-span-10">{children}</div>
    </div>
  );
}

function ConstituentsTable() {
  return (
    <Table label="Constituents">
      <TableCaption>
        Constituents
        <StatusTag status="Reference" />
        <span className="ml-auto text-sm font-normal text-secondary">Sorted by target weight</span>
      </TableCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Asset</TableHeader>
          <TableHeader>Issuer</TableHeader>
          <TableHeader numeric>Target weight</TableHeader>
          <TableHeader numeric>Reference price (USD)</TableHeader>
          <TableHeader numeric>24H change</TableHeader>
          <TableHeader>Token</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {sampleConstituents.map((row) => (
          <TableRow key={row.ticker}>
            <TableRowHeader>{row.ticker}</TableRowHeader>
            <TableCell className="text-secondary">{row.name}</TableCell>
            <TableCell numeric>{formatPercent(row.targetWeightBps)}</TableCell>
            <TableCell numeric>{formatPrice(row.referencePriceUsd6, 6)}</TableCell>
            <TableCell numeric className={signClass(row.change24hBps)}>
              {formatSignedPercent(row.change24hBps)}
            </TableCell>
            <TableCell className="font-mono text-sm text-secondary">{shortenAddress(row.tokenAddress)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFoot>
        <TableRow>
          <TableRowHeader>Total</TableRowHeader>
          <TableCell />
          <TableCell numeric>
            {formatPercent(sampleConstituents.reduce((sum, row) => sum + row.targetWeightBps, 0n))}
          </TableCell>
          <TableCell colSpan={3} />
        </TableRow>
      </TableFoot>
    </Table>
  );
}

function DriftTable() {
  return (
    <Table label="Drift" dense>
      <TableCaption>
        Drift
        <StatusTag status="Actual" />
      </TableCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Asset</TableHeader>
          <TableHeader numeric>Target weight</TableHeader>
          <TableHeader numeric>Actual weight</TableHeader>
          <TableHeader numeric>Drift (pp)</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {sampleConstituents.map((row) => (
          <TableRow key={row.ticker}>
            <TableRowHeader>{row.ticker}</TableRowHeader>
            <TableCell numeric>{formatPercent(row.targetWeightBps)}</TableCell>
            <TableCell numeric>{formatPercent(row.actualWeightBps)}</TableCell>
            <TableCell numeric>
              {formatPercentagePoints(row.actualWeightBps - row.targetWeightBps).replace(" pp", "")}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function LoadingTable() {
  return (
    <div aria-busy="true">
      <Table label="Constituents, loading">
        <TableCaption>Constituents</TableCaption>
        <TableHead>
          <TableRow>
            <TableHeader>Asset</TableHeader>
            <TableHeader numeric>Target weight</TableHeader>
            <TableHeader numeric>Reference price (USD)</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {["w-12", "w-10", "w-14"].map((width) => (
            <TableRow key={width}>
              <TableCell>
                <Skeleton className={width} />
              </TableCell>
              <TableCell>
                <Skeleton className="ml-auto w-12" />
              </TableCell>
              <TableCell>
                <Skeleton className="ml-auto w-14" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function ComponentReferencePage() {
  return (
    <Container className="flex flex-col gap-8 py-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-xl font-medium">Component reference</h1>
        <p className="max-w-measure text-md text-secondary">
          Every component of the design system in every state. This page is a development reference and is excluded from
          search indexing.
        </p>
        <div className="max-w-3xl">
          <Callout tone="warning" title="Everything on this page is sample data.">
            The index, the issuers, the prices, the addresses and the timestamps are invented to show realistic shapes.
            None of it describes a real asset or a live system.
          </Callout>
        </div>
      </header>

      <Section title="Color" note="Each swatch shows the token in the active theme.">
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-5">
          {colorTokens.map((group) => (
            <ul key={group[0]} className="flex flex-col gap-2">
              {group.map((token) => (
                <li key={token} className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="size-8 shrink-0 rounded-md border"
                    style={{ backgroundColor: `var(--${token})` }}
                  />
                  <code className="font-mono text-sm">--{token}</code>
                </li>
              ))}
            </ul>
          ))}
        </div>
      </Section>

      <Section title="Type scale" note="Size and line height in pixels at the default root size.">
        <table className="w-full text-left">
          <tbody>
            {typeScale.map(([token, metrics, use]) => (
              <tr key={token} className="align-baseline">
                <th scope="row" className="w-24 py-2 pr-4 font-mono text-sm font-normal text-secondary">
                  {token}
                </th>
                <td className={cx("py-2 pr-4 font-medium", token)}>Index level 1,084.27</td>
                <td className="num hidden py-2 pr-4 text-sm text-secondary whitespace-nowrap sm:table-cell">
                  {metrics}
                </td>
                <td className="hidden py-2 text-sm text-secondary md:table-cell">{use}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="font-mono text-sm text-secondary">
          Mono is for identifiers only: 0x4f1a...c2e7, a3f9c21e, GET /v1/indexes/SCI6
        </p>
      </Section>

      <Section title="Button" note="One primary button per screen. The verb states what will happen.">
        <Row label="Primary">
          <Button variant="primary">Start replicating</Button>
          <Button variant="primary" size="lg">
            Start replicating
          </Button>
          <Button variant="primary" loading loadingLabel="Requesting quotes">
            Start replicating
          </Button>
          <Button variant="primary" disabled>
            Start replicating
          </Button>
        </Row>
        <Row label="Secondary">
          <Button>Preview replication</Button>
          <Button size="lg">Preview replication</Button>
          <Button loading loadingLabel="Calculating">
            Preview replication
          </Button>
          <Button disabled>Preview replication</Button>
        </Row>
        <Row label="Ghost">
          <Button variant="ghost">Download CSV</Button>
          <Button variant="ghost" disabled>
            Download CSV
          </Button>
        </Row>
        <Row label="Destructive">
          <Button variant="destructive">Stop replicating</Button>
          <Button variant="destructive" disabled>
            Stop replicating
          </Button>
        </Row>
      </Section>

      <Section title="Link">
        <Row label="Inline">
          <p className="max-w-measure">
            Weights are recalculated from the published rules. Read the <Link href="/">overview</Link> or open the{" "}
            <Link href="https://github.com/salazarsebas/equityos">source repository</Link>.
          </p>
        </Row>
        <Row label="Quiet">
          <Link href="/" variant="quiet">
            Overview
          </Link>
        </Row>
      </Section>

      <Section title="Form controls">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
          <Field label="Amount (USD)" hint="Minimum effective size for this index is 250.00 USD.">
            {(control) => <Input {...control} inputMode="decimal" defaultValue="1,000.00" className="num" />}
          </Field>
          <Field label="Maximum weight (%)" error="Enter a value between 10.00 and 100.00.">
            {(control) => <Input {...control} inputMode="decimal" defaultValue="4.00" className="num" />}
          </Field>
          <Field label="Rebalance frequency">
            {(control) => (
              <Select {...control} defaultValue="monthly">
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
              </Select>
            )}
          </Field>
          <Field label="Index symbol" hint="Set when the index is published.">
            {(control) => <Input {...control} disabled defaultValue="SCI6" className="font-mono" />}
          </Field>
        </div>
        <div className="flex flex-col gap-3">
          <Checkbox label="Rebalance when drift exceeds 2.00 pp" defaultChecked />
          <Checkbox label="Include assets my wallet cannot hold" />
          <Checkbox label="Execute onchain (not available yet)" disabled />
        </div>
      </Section>

      <Section
        title="Tag"
        note="A tag appears once per scope. Positive and negative are for the sign of a return only."
      >
        <Row label="Tones">
          <Tag>v3</Tag>
          <Tag tone="info">Info</Tag>
          <Tag tone="positive">Positive</Tag>
          <Tag tone="negative">Negative</Tag>
          <Tag tone="warning">Warning</Tag>
        </Row>
        <Row label="Status set">
          {STATUSES.map((status) => (
            <StatusTag key={status} status={status} />
          ))}
        </Row>
      </Section>

      <Section title="Callout">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Callout title="An index is a published methodology, not a fund.">
            A wallet that replicates it holds the constituent tokens directly.
          </Callout>
          <Callout tone="info" title="Version 3 was published on 2026-11-02.">
            Wallets replicating version 2 keep their targets until they choose to move.
          </Callout>
          <Callout tone="warning" title="Maximum drift is 3.21 pp, above the 2.00 pp threshold.">
            A rebalance of 4 swaps brings every weight back to target.
          </Callout>
          <Callout tone="negative" title="2 of 9 swaps failed." role="status">
            Your wallet holds the 7 assets that were bought and 412.05 USDC that was not spent. Request new quotes for
            the remaining 2 swaps.
          </Callout>
        </div>
      </Section>

      <Section title="Stat and source line" note="Label and value pairs on hairlines, with one source line per region.">
        <StatGrid>
          <Stat
            label={
              <>
                Index level <StatusTag status="Theoretical" />
              </>
            }
            value={formatFixed(sampleIndex.levelE2, 2, 2)}
          />
          <Stat label="30D" value={formatSignedPercent(sampleIndex.return30dBps)} tone="positive" />
          <Stat label="Constituents" value={formatCount(BigInt(sampleConstituents.length))} />
          <Stat label="Maximum weight" value={formatPercent(sampleIndex.maxWeightBps)} />
          <Stat label="Tracked value" value={formatCompact(sampleIndex.trackedValueUsd6, 6)} unit="USD" />
          <Stat label="Replicating wallets" value={MISSING} />
        </StatGrid>
        <div className="flex flex-col gap-2">
          <SourceLine
            label="Reference prices"
            source={sampleIndex.priceSource}
            asOfUnixSeconds={sampleIndex.asOfUnixSeconds}
          />
          <SourceLine
            label="Reference prices"
            source={sampleIndex.priceSource}
            asOfUnixSeconds={sampleIndex.asOfUnixSeconds}
            note="Market closed"
          />
          <SourceLine
            label="Reference prices"
            source={sampleIndex.priceSource}
            asOfUnixSeconds={sampleIndex.asOfUnixSeconds}
            stale="oldest 14 min"
          />
        </div>
      </Section>

      <Section
        title="Data table"
        note="Horizontal rules only. Numbers are right-aligned with tabular figures. On a narrow screen the table scrolls sideways and the first column stays in place."
      >
        <Grid className="gap-y-6">
          <div className="col-span-12 lg:col-span-8">
            <ConstituentsTable />
          </div>
          <div className="col-span-12 flex flex-col gap-2 lg:col-span-4">
            <DriftTable />
            <p className="text-xs text-secondary">Dense variant, 32 px rows.</p>
          </div>
          <div className="col-span-12 flex flex-col gap-2 lg:col-span-8">
            <LoadingTable />
            <p className="text-xs text-secondary">Loading: static skeletons at the final row height.</p>
          </div>
        </Grid>
      </Section>

      <Section title="Tabs" note="Arrow keys move between tabs. Home and End jump to the first and last.">
        <div className="lg:w-2/3">
          <Tabs
            label="Index sections"
            items={[
              { id: "overview", label: "Overview", content: <ConstituentsTable /> },
              {
                id: "methodology",
                label: "Methodology",
                content: (
                  <p className="max-w-measure">
                    Selects the 6 largest eligible assets, weights them by market value and caps each weight at{" "}
                    {formatPercent(sampleIndex.maxWeightBps)}.
                  </p>
                ),
              },
              {
                id: "performance",
                label: "Performance",
                content: (
                  <EmptyState title="No performance history yet.">
                    This index was published on 2026-11-20. Performance appears after the first full day of reference
                    prices.
                  </EmptyState>
                ),
              },
            ]}
          />
        </div>
      </Section>

      <Section title="Empty and error states">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <EmptyState title="You are not replicating any index." action={<Button>Browse indexes</Button>}>
            A replication records the index version and the wallet that follows it. It appears here once it starts.
          </EmptyState>
          <ErrorState title="Composition could not be calculated." action={<Button>Show last calculation</Button>}>
            The reference price for HLIO is missing. The last successful calculation is from 2026-11-20 21:00 UTC and is
            unchanged. Try again after the next price update.
          </ErrorState>
        </div>
      </Section>

      <Section title="Code block" note="Commands wrap anywhere. JSON keeps its lines and scrolls inside the block.">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <CodeBlock title="Shell" code={'curl "http://localhost:3000/api/v1/status"'} copyLabel="command" />
          <CodeBlock
            title="JSON"
            code={JSON.stringify({ error: { code: "index_not_found", message: "Example.", details: null } }, null, 2)}
            copyLabel="example body"
            overflow="scroll"
          />
        </div>
      </Section>

      <Section
        title="Dialog"
        note="Native dialog element: focus is trapped, Escape closes it and focus returns to the trigger."
      >
        <div>
          <DialogDemo />
        </div>
      </Section>

      <Section title="Number and time formats" note="Every value enters as an integer in an explicit unit.">
        <div className="lg:w-2/3">
          <Table label="Number and time formats" dense>
            <TableHead>
              <TableRow>
                <TableHeader>Quantity</TableHeader>
                <TableHeader>Input</TableHeader>
                <TableHeader numeric>Output</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {formats.map(([quantity, input, output]) => (
                <TableRow key={quantity}>
                  <TableRowHeader>{quantity}</TableRowHeader>
                  <TableCell className="font-mono text-sm text-secondary">{input}</TableCell>
                  <TableCell numeric>{output}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>
    </Container>
  );
}
