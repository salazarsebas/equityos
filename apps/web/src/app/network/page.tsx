import type { Metadata } from "next";
import { Container } from "@/components/shell/container";
import { Callout } from "@/components/ui/callout";
import { Link } from "@/components/ui/link";
import { SourceLine } from "@/components/ui/source-line";
import { StatGrid } from "@/components/ui/stat";
import { EmptyState, ErrorState } from "@/components/ui/state";
import { formatCount, formatUsd } from "@/lib/format";
import { chainName } from "@/lib/indexes/chains";
import { getNetworkService, type NetworkRead } from "@/server/network";
import { getRegistryReplay, LOCAL_CHAIN_ID } from "@/server/registry";
import { RegistryNotice } from "../indexes/registry-states";
import {
  AttestationTable,
  blockRange,
  count,
  DailySeries,
  Exclusions,
  HowTheyAreMade,
  IndexTable,
  MetricStat,
  Region,
} from "./sections";

export const metadata: Metadata = {
  title: "Network",
  description:
    "Activity of the EquityOS registry and rebalance log, computed from onchain events only: published indexes, versions, rebalance attestations by tier and the reference value they moved, each with its definition.",
  alternates: { canonical: "/network" },
};

/** Rendered on every request: the metrics service bounds its reads with a ten second cache. */
export const revalidate = 0;

type Read = Extract<NetworkRead, { status: "ok" }>;

async function load(): Promise<NetworkRead | "unavailable"> {
  try {
    return await getNetworkService().read();
  } catch (error) {
    console.error("network page: the metrics could not be computed", error);
    return "unavailable";
  }
}

function Usage({ read, asOf }: { read: Read; asOf: bigint }) {
  const { metrics } = read;
  const excluded = new Set(read.exclusions.map(({ address }) => address));
  const counted = read.classified.filter(({ event }) => !excluded.has(event.account));
  if (metrics.attestations.value === 0) {
    return (
      <Region title="Usage">
        <p className="max-w-measure text-base">
          No rebalance attestation has been recorded in {blockRange(metrics.attestations)}. Usage figures appear here
          once an account records one.
        </p>
      </Region>
    );
  }
  const { attestationsTierB: tierB, attestationsUnmatched: unmatched } = metrics;
  return (
    <Region
      title="Usage"
      lead="Rebalance attestations count in a headline figure only when their own transaction moves the attested constituents to or from the attesting account."
    >
      <div className="flex flex-col gap-3">
        <StatGrid columns={4}>
          <MetricStat metric={metrics.attestationsTierA} value={count(metrics.attestationsTierA)} />
          <MetricStat metric={metrics.accountsTierA} value={count(metrics.accountsTierA)} />
          <MetricStat metric={metrics.accountsWithinTolerance} value={count(metrics.accountsWithinTolerance)} />
          <MetricStat
            metric={metrics.tierAReferenceValueUsdE8}
            value={formatUsd(metrics.tierAReferenceValueUsdE8.value, 8)}
            unit="USD"
          />
        </StatGrid>
        <p className="max-w-measure text-base text-secondary">
          Not in the figures above: {count(tierB)} <Link href={`#${tierB.id}`}>linked (tier B)</Link> and{" "}
          {count(unmatched)} <Link href={`#${unmatched.id}`}>unmatched</Link>, of {count(metrics.attestations)}{" "}
          attestations recorded.
        </p>
        {read.chainId === LOCAL_CHAIN_ID ? (
          <p className="max-w-measure text-base text-secondary">
            On a local chain the constituent tokens and their reference feeds are mocks installed by the seed script,
            and every feed answers 100.00 USD. The values above are examples, not market values.
          </p>
        ) : null}
        <SourceLine
          label="Usage"
          source={`RebalanceRecorded logs, receipts and constituent Transfer logs, ${blockRange(metrics.attestations)}; values at the Chainlink reference prices of each block`}
          asOfUnixSeconds={asOf}
        />
      </div>
      <DailySeries metric={metrics.tierAPerDay} noun="tier A attestations" />
      <IndexTable read={read} />
      <AttestationTable read={read} rows={counted} />
    </Region>
  );
}

function Metrics({ read }: { read: Read }) {
  const { metrics } = read;
  const replay = getRegistryReplay();
  // A replay is a past block: its time is the time of the data. A live read is as of its computation.
  const asOf = BigInt(replay === null ? metrics.indexesPublished.computedAt : replay.blockTimestamp);
  return (
    <div className="flex flex-col gap-8">
      <SourceLine
        label="Events"
        source={`IndexRegistry ${read.registry} and RebalanceLog ${read.rebalanceLog} on ${chainName(read.chainId)} (chain id ${read.chainId}), ${blockRange(metrics.indexesPublished)}`}
        asOfUnixSeconds={asOf}
      />
      {read.scan.complete && read.usageComplete ? null : (
        <Callout tone="warning" title="The scan has not reached the latest block yet.">
          The figures cover {blockRange(metrics.attestations)} of the {formatCount(read.scan.targetBlock)} blocks to
          scan, and grow with each visit until they reach it.
        </Callout>
      )}
      <Region title="Registry">
        <div className="flex flex-col gap-3">
          <StatGrid columns={4}>
            <MetricStat metric={metrics.indexesPublished} value={count(metrics.indexesPublished)} />
            <MetricStat metric={metrics.versionsPublished} value={count(metrics.versionsPublished)} />
            <MetricStat metric={metrics.distinctCreators} value={count(metrics.distinctCreators)} />
            <MetricStat metric={metrics.indexesDeprecated} value={count(metrics.indexesDeprecated)} />
          </StatGrid>
          <SourceLine
            label="Registry"
            source={`IndexCreated, VersionPublished and IndexDeprecated logs, ${blockRange(metrics.indexesPublished)}`}
            asOfUnixSeconds={asOf}
          />
        </div>
        <DailySeries metric={metrics.versionsPerDay} noun="versions published" />
      </Region>
      <Usage read={read} asOf={asOf} />
      <Region title="Excluded accounts" lead="Team, test and operator accounts. Never in a headline figure.">
        <Exclusions read={read} />
      </Region>
    </div>
  );
}

function NotDeployed({ read }: { read: Extract<NetworkRead, { status: "registry_not_deployed" }> }) {
  const chain = chainName(read.chainId);
  return (
    <EmptyState title={`The index registry is not deployed on ${chain} yet`}>
      <p>
        There is nothing to measure: on {chain} (chain id {read.chainId}) no index can be published and no rebalance
        recorded until the registry and the rebalance log are deployed. No figure is shown rather than a row of zeros
        that would describe a network that does not exist.
      </p>
      <p className="mt-2">
        Address the registry will have:{" "}
        <span className="font-mono text-sm break-all text-primary">{read.registry.toLowerCase()}</span>
      </p>
    </EmptyState>
  );
}

export default async function NetworkPage() {
  const read = await load();
  const chainLabel =
    read === "unavailable" ? "the configured chain" : `${chainName(read.chainId)} (chain id ${read.chainId})`;
  return (
    <Container className="flex flex-col gap-8 py-8 md:py-12">
      <div>
        <h1 className="text-xl font-medium">Network</h1>
        <p className="mt-2 max-w-measure text-md text-secondary">
          Activity of the EquityOS registry and rebalance log, read from onchain events only. Each figure links to its
          definition and names the blocks it covers.
        </p>
      </div>
      {read === "unavailable" ? (
        <ErrorState title="The metrics cannot be computed right now">
          The chain endpoint did not answer or answered something unexpected, so no figure is shown rather than an old
          or partial one. Reload in a few seconds, or read <Link href="/api/v1/status">the API status</Link>.
        </ErrorState>
      ) : read.status === "ok" ? (
        <>
          <RegistryNotice chainId={read.chainId} />
          <Metrics read={read} />
        </>
      ) : (
        <NotDeployed read={read} />
      )}
      <HowTheyAreMade chainLabel={chainLabel} />
    </Container>
  );
}
