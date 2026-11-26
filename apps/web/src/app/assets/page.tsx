import { marketPhaseAt } from "@equityos/core";
import type { Metadata } from "next";
import NextLink from "next/link";
import type { ReactNode } from "react";
import { oldestUpdate } from "@/components/market/reference-price";
import { Container } from "@/components/shell/container";
import { Callout } from "@/components/ui/callout";
import { cx } from "@/components/ui/cx";
import { SourceLine } from "@/components/ui/source-line";
import { formatCount, formatUtcDateTime } from "@/lib/format";
import { getMarketData, listAssets, type MarketSnapshot, marketDataMode } from "@/server/market";
import { AssetsTable } from "./assets-table";

export const metadata: Metadata = {
  title: "Assets",
  description:
    "The tokenized stocks listed on Base, with their token address, minted supply, reference price and index eligibility, read from public sources.",
  alternates: { canonical: "/assets" },
};

/**
 * Rendered on every request and never stored: the page is only as current as its data, and the market data
 * layer already bounds the load on its sources with a 15 second cache.
 */
export const revalidate = 0;

function ViewLink({
  href,
  current,
  children,
}: {
  href: "/assets" | "/assets?view=all";
  current: boolean;
  children: ReactNode;
}) {
  return (
    <NextLink
      href={href}
      aria-current={current ? "page" : undefined}
      className={cx(
        "inline-flex h-10 items-center border-b-2 px-2 pointer-coarse:h-11 font-medium whitespace-nowrap -outline-offset-2 transition-colors duration-[120ms]",
        current ? "border-accent text-primary" : "border-transparent text-secondary hover:text-primary",
      )}
    >
      {children}
    </NextLink>
  );
}

function Definition({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-medium text-primary">{term}</dt>
      <dd className="mt-1 max-w-measure text-secondary">{children}</dd>
    </div>
  );
}

/** Conditions of the data that a reader must know before reading the table. */
function Notices({ snapshot, unavailable, priced }: { snapshot: MarketSnapshot; unavailable: number; priced: number }) {
  const { assetList, onchain } = snapshot;
  return (
    <>
      {marketDataMode() === "replay" ? (
        <Callout tone="warning" title="This server shows a recording, not current data.">
          Every value below was read at Base mainnet block {formatCount(onchain.blockNumber)} on{" "}
          {formatUtcDateTime(BigInt(onchain.blockTimestamp))} and is replayed for testing.
        </Callout>
      ) : null}
      {assetList.servedStale || onchain.servedStale ? (
        <Callout tone="warning" title="A data source is not answering. This is the last copy that was read.">
          {onchain.servedStale
            ? `Token state and reference prices were read at ${formatUtcDateTime(BigInt(onchain.fetchedAt))}. `
            : `The asset list was read at ${formatUtcDateTime(BigInt(assetList.fetchedAt))}. `}
          Newer values may exist that this page does not show.
        </Callout>
      ) : null}
      {unavailable > 0 ? (
        <Callout
          tone="warning"
          title={
            unavailable === priced
              ? "Reference prices are unavailable."
              : `Reference prices are unavailable for ${formatCount(BigInt(unavailable))} of ${formatCount(BigInt(priced))} eligible assets.`
          }
        >
          The asset list and the token state loaded. A feed that cannot be read, or that has not published within its
          expected interval, shows no price: no other source is substituted.
        </Callout>
      ) : null}
    </>
  );
}

export default async function AssetsPage({ searchParams }: PageProps<"/assets">) {
  const showAll = (await searchParams).view === "all";
  const snapshot = await getMarketData().getSnapshot();
  const eligible = listAssets(snapshot, true);
  const rows = showAll ? listAssets(snapshot) : eligible;
  const unavailable = eligible.filter((entry) => entry.referencePrice?.status === "unavailable").length;
  const { onchain } = snapshot;

  return (
    <Container className="py-8 md:py-12">
      <h1 className="text-xl font-medium">Assets</h1>
      <p className="mt-2 max-w-measure text-md text-secondary">
        The tokenized stocks listed on Base by their issuer. Supply and share multiplier are read from each token
        contract, and prices from oracle feeds, all at one block.
      </p>

      <dl className="mt-6 grid gap-x-6 gap-y-4 border-t pt-4 text-sm md:grid-cols-2">
        <Definition term="Reference price">
          The latest value published by the oracle feed mapped to the token, in USD per token. It is an indication of
          value, not an executable price: no trade is guaranteed at it. Feeds follow US market hours, so on weekends and
          holidays the value is the last one published before the close.
        </Definition>
        <Definition term="Index-eligible">
          An asset can be a constituent of an index when it is in the issuer's list, its token is initialized onchain
          with the listed decimals, its supply is above zero and it has a verified reference feed.
        </Definition>
      </dl>

      <nav aria-label="Asset view" className="mt-6 flex gap-2 shadow-[inset_0_-1px_0_var(--border)]">
        <ViewLink href="/assets" current={!showAll}>
          Index-eligible{" "}
          <span className="num ml-1 font-normal text-secondary">{formatCount(BigInt(eligible.length))}</span>
        </ViewLink>
        <ViewLink href="/assets?view=all" current={showAll}>
          All listed{" "}
          <span className="num ml-1 font-normal text-secondary">{formatCount(BigInt(snapshot.assets.size))}</span>
        </ViewLink>
      </nav>

      <div className="mt-6 flex flex-col gap-3">
        <Notices snapshot={snapshot} unavailable={unavailable} priced={eligible.length} />
        <AssetsTable
          title={showAll ? "All listed assets" : "Index-eligible assets"}
          rows={rows}
          showEligibility={showAll}
          marketClosed={marketPhaseAt(snapshot.observedAt) === "closed"}
          apiHref={showAll ? "/api/v1/assets" : "/api/v1/assets?eligible=true"}
        />
        <SourceLine
          label="Listing, token state and reference prices"
          source={`Coinbase tokenized stocks API, Base mainnet block ${formatCount(onchain.blockNumber)}, Chainlink feeds`}
          asOfUnixSeconds={BigInt(oldestUpdate(rows) ?? onchain.blockTimestamp)}
          note="oldest value shown"
          {...(onchain.servedStale ? { stale: "source not answering" } : {})}
        />
      </div>
    </Container>
  );
}
