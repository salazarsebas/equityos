"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useConnection } from "wagmi";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/copy-button";
import { Link } from "@/components/ui/link";
import { SourceLine } from "@/components/ui/source-line";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState, ErrorState } from "@/components/ui/state";
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
import { Tag } from "@/components/ui/tag";
import { ConnectDialog } from "@/components/wallet/connect-dialog";
import { WalletRuntime } from "@/components/wallet/runtime";
import { formatCount, formatFixed, formatTokenQuantity, formatUsd, MISSING, shortenAddress } from "@/lib/format";
import {
  type ApiPortfolio,
  type ComparisonState,
  comparisonQuery,
  isApiError,
  readEnvelope,
} from "@/lib/portfolio/api";
import { lastIndexOf, rememberIndex } from "@/lib/portfolio/last-index";
import { addressExplorer, HOME_CHAIN } from "@/lib/wallet/chains";
import { DriftTable, Missing, PriceCell } from "./drift-table";
import { IssueList, PlanPanel } from "./plan-panel";
import { PortfolioSkeleton } from "./skeleton";

function points(bps: number): string {
  return `${formatFixed(BigInt(bps), 2, 2)} pp`;
}

function portfolioHref(state: ComparisonState): string {
  return `/portfolio?${comparisonQuery(state)}`;
}

/** The comparison could not be made: what happened, what it means for the address, and what to do next. */
function ComparisonError({ error, state, retry }: { error: Error; state: ComparisonState; retry: () => void }) {
  const code = isApiError(error) ? error.code : "unknown";
  if (code === "version_not_conformant") {
    const details = isApiError(error) ? error.details : null;
    const check = typeof details?.failedCheck === "string" ? ` It fails check ${details.failedCheck}.` : "";
    return (
      <ErrorState
        title={`Version ${typeof details?.version === "number" ? details.version : (state.version ?? "")} of this index fails verification, so it is not compared.`}
        action={<Link href={`/indexes/${state.index}`}>Open the index and its verification</Link>}
      >
        A version that fails verification has no target weights that can be trusted.{check}
      </ErrorState>
    );
  }
  if (code === "index_not_found" || code === "version_not_found" || code === "invalid_identifier") {
    return (
      <ErrorState title="This index or version does not exist" action={<Link href="/indexes">Open the explorer</Link>}>
        The registry holds no{" "}
        {code === "version_not_found" ? "version with this number for this index" : "index with this identifier"}.
        Choose another one above.
      </ErrorState>
    );
  }
  return (
    <ErrorState title="The comparison could not be computed" action={<Button onClick={retry}>Try again</Button>}>
      {error.message} This page only reads, so the address and its assets are not affected.
    </ErrorState>
  );
}

function Header({ data, state, connected }: { data: ApiPortfolio; state: ComparisonState; connected: boolean }) {
  const { index } = data;
  const explorer = addressExplorer(HOME_CHAIN, data.address);
  const profile = index.isLatest
    ? `/indexes/${index.identifier}`
    : `/indexes/${index.identifier}/versions/${index.version}`;
  return (
    <header className="flex flex-col gap-3">
      <h2 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-lg font-medium">
        <span className="font-mono" title={data.address}>
          {shortenAddress(data.address)}
        </span>
        <span className="font-normal text-secondary">compared with</span>
        <Link href={profile}>{index.name}</Link>
        <Tag>v{index.version}</Tag>
      </h2>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-secondary">
        <span>{connected ? "Connected wallet" : "Read-only lookup: this page is not connected to the address"}</span>
        <CopyButton value={data.address} label="Copy address" />
        <Link href={explorer.url}>View on {explorer.name}</Link>
      </p>
      {index.isLatest ? null : (
        <Callout
          tone="warning"
          title={`Version ${index.latestVersion} of this index is published. This comparison uses version ${index.version}.`}
        >
          The target weights differ between versions.{" "}
          <Link href={portfolioHref({ ...state, version: null })}>Compare with version {index.latestVersion}</Link>
        </Callout>
      )}
    </header>
  );
}

function Facts({ data }: { data: ApiPortfolio }) {
  const threshold = data.index.driftThresholdBps;
  const drift = data.drift;
  const widest = drift === null ? undefined : data.constituents.find(({ token }) => token === drift.maxDriftToken);
  const above = drift !== null && drift.maxAbsDriftBps >= threshold;
  return (
    <div className="flex flex-col gap-2">
      <StatGrid columns={4}>
        <Stat
          label="Portfolio value at reference prices"
          value={
            data.totals.deployableValueUsdE8 === null ? MISSING : formatUsd(BigInt(data.totals.deployableValueUsdE8), 8)
          }
          unit="USD"
        />
        <Stat label="Largest drift" value={drift === null ? MISSING : points(drift.maxAbsDriftBps)} />
        <Stat label="Drift threshold of the index" value={points(threshold)} />
        <Stat label="USDC not invested" value={formatUsd(BigInt(data.totals.quoteBalance), 6)} unit="USDC" />
      </StatGrid>
      <p data-testid="threshold-status" className={above ? "font-medium text-primary" : "text-secondary"}>
        {drift === null
          ? "No drift: nothing is invested in the constituents, or a constituent has no usable price."
          : above
            ? `Above threshold by ${points(drift.maxAbsDriftBps - threshold)}: ${widest?.symbol ?? "a constituent"} is ${points(drift.maxAbsDriftBps)} ${(widest?.driftBps ?? 0) > 0 ? "above" : "below"} its target weight.`
            : `Within threshold: the largest drift is ${points(drift.maxAbsDriftBps)}.`}
      </p>
    </div>
  );
}

function OutsideIndex({ data }: { data: ApiPortfolio }) {
  return (
    <section aria-labelledby="outside-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="outside-heading" className="text-lg font-medium">
          Outside this index
        </h2>
        <p className="mt-1 max-w-measure text-secondary">
          Other index-eligible assets the address holds. They are not counted in any value, weight or drift above, and
          the plan never sells them.
        </p>
      </div>
      {data.outsideIndex.length === 0 ? (
        <p className="text-secondary">The address holds no other index-eligible asset.</p>
      ) : (
        <Table label="Held outside this index">
          <TableCaption>
            <span>Held outside this index</span>
            <span className="num font-normal text-secondary">{formatCount(BigInt(data.outsideIndex.length))}</span>
          </TableCaption>
          <TableHead>
            <TableRow>
              <TableHeader>Asset</TableHeader>
              <TableHeader numeric>Balance (tokens)</TableHeader>
              <TableHeader numeric>Reference price (USD)</TableHeader>
              <TableHeader numeric>Value (USD)</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.outsideIndex.map((row) => (
              <TableRow key={row.token}>
                <TableRowHeader className="font-mono text-sm">{row.symbol ?? row.token}</TableRowHeader>
                <TableCell numeric>{formatTokenQuantity(BigInt(row.balance), row.decimals)}</TableCell>
                <TableCell numeric>
                  <PriceCell price={row.referencePrice} />
                </TableCell>
                <TableCell numeric>
                  {row.valueUsdE8 === null ? <Missing /> : formatUsd(BigInt(row.valueUsdE8), 8)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function Comparison({ state, connected }: { state: ComparisonState; connected: boolean }) {
  const query = useQuery({
    queryKey: ["api", "v1", "portfolio", comparisonQuery(state).toString()],
    queryFn: async ({ signal }) =>
      readEnvelope<ApiPortfolio>(await fetch(`/api/v1/portfolio?${comparisonQuery(state)}`, { signal })),
    retry: false,
    staleTime: 15_000,
  });
  const loaded = query.data !== undefined;
  useEffect(() => {
    if (loaded) rememberIndex(state.address, state.index);
  }, [loaded, state.address, state.index]);

  if (query.isPending) return <PortfolioSkeleton />;
  if (query.isError) return <ComparisonError error={query.error} state={state} retry={() => void query.refetch()} />;
  const { data, meta } = query.data;
  const symbols = new Map(
    [...data.constituents, ...data.outsideIndex].map(({ token, symbol }) => [token, symbol ?? token]),
  );
  const symbolOf = (token: string) => symbols.get(token) ?? token;
  const blockers = data.issues.filter(({ severity }) => severity === "blocker");
  const updated = data.constituents.flatMap(({ referencePrice }) => referencePrice.updatedAt ?? []).sort()[0];
  return (
    <div className="flex flex-col gap-6">
      <Header data={data} state={state} connected={connected} />
      <Facts data={data} />
      {blockers.length > 0 ? (
        <Callout tone="warning" title="The valuation is incomplete, so no total, weight or drift is shown.">
          <IssueList issues={blockers} symbolOf={symbolOf} />
        </Callout>
      ) : null}
      <div className="flex flex-col gap-3">
        <DriftTable
          positions={data.constituents}
          thresholdBps={data.index.driftThresholdBps}
          investedValueUsdE8={data.totals.investedValueUsdE8}
          marketClosed={meta.marketPhase === "closed"}
          apiHref={`/api/v1/portfolio?${comparisonQuery(state)}`}
        />
        <SourceLine
          label="Balances and reference prices"
          source={
            meta.balances.blockNumber === meta.datasets.onchain.blockNumber
              ? `Base mainnet block ${formatCount(BigInt(meta.balances.blockNumber))}`
              : `Base mainnet, balances at block ${formatCount(BigInt(meta.balances.blockNumber))}, prices at block ${formatCount(BigInt(meta.datasets.onchain.blockNumber))}`
          }
          asOfUnixSeconds={BigInt(Math.floor(Date.parse(updated ?? meta.balances.blockTimestamp) / 1000))}
          note={meta.marketPhase === "closed" ? "Market closed: values use the last close" : "oldest price shown"}
          {...(meta.datasets.onchain.servedStale ? { stale: "source not answering" } : {})}
        />
        <IssueList issues={data.issues.filter(({ severity }) => severity === "warning")} symbolOf={symbolOf} />
      </div>
      <OutsideIndex data={data} />
      <PlanPanel state={state} symbolOf={symbolOf} shown={new Set(data.issues.map(({ code }) => code))} />
    </div>
  );
}

type ViewProps = { address: string | null; index: string; version: number | null };

/** Uses the address of the URL, or the connected wallet, which is then written to the URL. */
function Resolve({ address, index, version }: ViewProps) {
  const { address: connected } = useConnection();
  const [connecting, setConnecting] = useState(false);
  const account = address ?? connected ?? null;
  useEffect(() => {
    if (address !== null || connected === undefined) return;
    const query = new URLSearchParams(window.location.search);
    query.set("address", connected);
    window.history.replaceState(window.history.state, "", `?${query}`);
  }, [address, connected]);

  if (account === null) {
    return (
      <>
        <EmptyState
          title={index === "" ? "Choose an index and an address" : "Choose an address to compare"}
          action={
            <Button variant="primary" onClick={() => setConnecting(true)}>
              Connect wallet
            </Button>
          }
        >
          Enter any address above, or connect a wallet to compare its own holdings. Connecting shares your public
          address only.
        </EmptyState>
        <ConnectDialog open={connecting} onClose={() => setConnecting(false)} />
      </>
    );
  }
  if (index === "") {
    const remembered = lastIndexOf(account);
    return remembered === null ? null : (
      <p className="text-secondary">
        Last index compared with {shortenAddress(account)} in this browser:{" "}
        <Link href={portfolioHref({ address: account, index: remembered, version: null })}>{remembered}</Link>
      </p>
    );
  }
  return <Comparison state={{ address: account, index, version }} connected={address === null} />;
}

/** Loaded on its own, in the browser only, by `PortfolioSlot`. */
export function PortfolioView(props: ViewProps) {
  return (
    <WalletRuntime>
      <Resolve {...props} />
    </WalletRuntime>
  );
}
